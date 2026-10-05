import { promises as fs } from 'node:fs';
import path from 'node:path';
import { env, pipeline } from '@xenova/transformers';
import { config } from '../../../config.js';
import { CLASSIFICATION_MODELS, DEFAULT_CLASSIFICATION_MODEL } from '../../../settings/settings.js';
import { getSettings } from '../../../settings/settings-store.js';
import {
  normalizeLabels,
  normalizeMode,
  normalizeText,
  normalizeThreshold,
  rankScores,
  selectLabels,
  type ClassificationMode,
  type LabelScore,
} from './core.js';
import { clearModelCache, modelCacheStatus, type ModelCacheStatus } from './cache.js';
import { createPipelineCache } from './pipeline-cache.js';

export { DEFAULT_MULTI_LABEL_THRESHOLD, type ClassificationMode, type LabelScore } from './core.js';

// On-device zero-shot text classification for the Dev Sessions agents.
//
// The classifier helper (agents/helpers/helper.ts has the family). This is
// deliberately *not* built on agents/local-llm.ts (Qwen via
// llama-helper/llama.cpp/GGUF): that's a causal chat model on a different
// runtime, while transformers.js's zero-shot-classification pipeline needs an
// ONNX sequence-classification model trained for NLI/MNLI. The two stacks
// don't mix — see docs/classification-tool.md.
//
// Everything here runs locally: the first call for a given model downloads its
// ONNX weights, every later call is free and offline.

// Model files live under this project's own state/ dir (next to
// meeting-sources/ and reference-docs/) rather than transformers.js's default
// OS cache location, so the cache is visible, gitignored and clearable from
// Settings. transformers.js nests each download under its model id
// ("Xenova/distilbert-base-uncased-mnli/..."), so the three curated models
// coexist without colliding.
export const CLASSIFICATION_CACHE_DIR = path.join(config.stateDir, 'classification-models');

export interface ClassifyTextParams {
  text: string;
  labels: string[];
  /** Defaults to 'single'. */
  mode?: ClassificationMode;
  /** Multi-label only; defaults to DEFAULT_MULTI_LABEL_THRESHOLD. */
  threshold?: number;
}

export interface ClassifyTextResult {
  /** The model that actually ran, so a caller can tell which one it got. */
  model: string;
  mode: ClassificationMode;
  /** The threshold applied in multi mode; null in single mode. */
  threshold: number | null;
  /**
   * What the tool picked: the single highest-scoring label in 'single' mode,
   * every label at or above the threshold (highest first) in 'multi' mode —
   * which can legitimately be empty if nothing clears it.
   */
  selected: LabelScore[];
  /** Every candidate label, highest score first, so the caller can see near-misses. */
  allScores: LabelScore[];
}

/** The shape transformers.js's zero-shot-classification pipeline actually has. */
type ZeroShotPipeline = ((
  text: string,
  labels: string[],
  options?: { multi_label?: boolean },
) => Promise<{ sequence: string; labels: string[]; scores: number[] }>) & {
  dispose?: () => Promise<void> | void;
};

// The library's `env` typings are generated from JSDoc and don't narrow these
// fields usefully; this cast keeps the few knobs we set honest and in one spot.
const transformersEnv = env as unknown as {
  cacheDir: string;
  allowLocalModels: boolean;
  allowRemoteModels: boolean;
  useFSCache: boolean;
};

function applyCacheEnv(): void {
  transformersEnv.cacheDir = CLASSIFICATION_CACHE_DIR;
  transformersEnv.useFSCache = true;
  // Don't look in transformers.js's `./models` convention — we only ever serve
  // from the cache dir above, populated from the Hub on first use.
  transformersEnv.allowLocalModels = false;
  transformersEnv.allowRemoteModels = true;
}

applyCacheEnv();

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// --- in-memory singleton -----------------------------------------------------
// Loaded once per harness-server process and reused across every agent role
// and session. Changing the model in Settings → Dev Agents doesn't restart
// anything: the next call sees a different id here and swaps lazily.

async function loadPipeline(model: string): Promise<ZeroShotPipeline> {
  applyCacheEnv();
  try {
    await fs.mkdir(CLASSIFICATION_CACHE_DIR, { recursive: true });
  } catch (err) {
    throw new Error(
      `Could not create the classification model cache directory at ${CLASSIFICATION_CACHE_DIR}: ${errorText(err)}`,
    );
  }
  try {
    return (await pipeline('zero-shot-classification', model)) as unknown as ZeroShotPipeline;
  } catch (err) {
    throw new Error(
      `Could not load the on-device classification model "${model}". ` +
        `Its files are downloaded once into ${CLASSIFICATION_CACHE_DIR}, so the very first use needs network access; ` +
        `after that it runs offline. You can pick a different model or clear the cache in Settings → Dev Agents. ` +
        `Underlying error: ${errorText(err)}`,
    );
  }
}

// One slot per process, swapped lazily when the selected model changes, so
// Settings → Dev Agents needs no server restart. The swap, shared-load and
// load-failure behavior is unit-tested in pipeline-cache.ts's suite.
const pipelineCache = createPipelineCache<ZeroShotPipeline>({
  load: loadPipeline,
  dispose: (pipe) => pipe.dispose?.(),
});

async function selectedModel(): Promise<string> {
  try {
    const settings = await getSettings();
    const chosen = settings.classification?.model?.trim();
    return chosen || DEFAULT_CLASSIFICATION_MODEL;
  } catch {
    // Unreadable settings file shouldn't make classification unavailable.
    return DEFAULT_CLASSIFICATION_MODEL;
  }
}

export async function classifyText(params: ClassifyTextParams): Promise<ClassifyTextResult> {
  // Input normalization and result selection live in core.ts,
  // which is unit-tested without a model; this function is the part that
  // actually loads and runs the pipeline.
  const text = normalizeText(params.text);
  const mode = normalizeMode(params.mode);
  const labels = normalizeLabels(params.labels);
  const threshold = normalizeThreshold(params.threshold, mode);

  const model = await selectedModel();
  const pipe = await pipelineCache.get(model);

  let output: { labels: string[]; scores: number[] };
  try {
    output = await pipe(text, labels, { multi_label: mode === 'multi' });
  } catch (err) {
    throw new Error(`On-device classification failed while running "${model}": ${errorText(err)}`);
  }

  if (!Array.isArray(output?.labels) || !Array.isArray(output?.scores)) {
    throw new Error(`On-device classification returned an unexpected result shape from "${model}".`);
  }

  const allScores: LabelScore[] = rankScores(output.labels, output.scores);
  const selected = selectLabels(allScores, threshold);

  return { model, mode, threshold, selected, allScores };
}

// --- cache management --------------------------------------------------------

export type ClassificationModelCacheStatus = ModelCacheStatus;

/**
 * On-disk cache state for each curated model, for Settings → Dev Agents.
 * Read fresh on demand rather than cached, same as localModelStatus().
 */
export async function classificationCacheStatus(): Promise<ClassificationModelCacheStatus[]> {
  return modelCacheStatus(
    CLASSIFICATION_CACHE_DIR,
    CLASSIFICATION_MODELS.map((option) => option.id),
  );
}

/**
 * Deletes every cached classification model (not just the selected one) and
 * drops the in-memory pipeline, so the next classify_text call re-downloads
 * whichever model is selected at that point.
 */
export async function clearClassificationCache(): Promise<void> {
  await pipelineCache.reset();

  try {
    await clearModelCache(CLASSIFICATION_CACHE_DIR);
  } catch (err) {
    throw new Error(`Could not clear the classification model cache at ${CLASSIFICATION_CACHE_DIR}: ${errorText(err)}`);
  }
}
