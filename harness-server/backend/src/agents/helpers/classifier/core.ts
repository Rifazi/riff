// The pure half of the on-device classification tool: input normalization and
// result selection, with no dependency on transformers.js, the settings store
// or the filesystem. Kept in its own module so the rules that decide what the
// tool accepts and what it returns can be unit-tested without downloading a
// model (see frontend/tests/harness-server/classification-core.test.ts) —
// classifier.ts owns everything that actually touches the pipeline.
//
// Every failure in here is a plain `throw`: both agent engines turn a thrown
// Error into a tool-level error for the model to read and retry, rather than
// failing the turn (see tool-defs-claude/wrap.ts and agents/sdk-client.ts).

/** Multi-label mode keeps every label scoring at least this, unless the caller overrides it. */
export const DEFAULT_MULTI_LABEL_THRESHOLD = 0.5;

export type ClassificationMode = 'single' | 'multi';

export interface LabelScore {
  label: string;
  score: number;
}

export function normalizeText(text: unknown): string {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (!trimmed) {
    throw new Error('classify_text needs a non-empty "text" to classify.');
  }
  return trimmed;
}

/** `mode` is optional on the tool schema; omitting it means 'single'. */
export function normalizeMode(mode: unknown): ClassificationMode {
  if (mode === undefined || mode === null) return 'single';
  if (mode !== 'single' && mode !== 'multi') {
    throw new Error(`classify_text "mode" must be "single" or "multi" (got ${String(mode)}).`);
  }
  return mode;
}

/** Trims, drops blanks and de-duplicates, preserving the caller's order. */
export function normalizeLabels(labels: unknown): string[] {
  if (!Array.isArray(labels)) {
    throw new Error('classify_text needs a "labels" array of at least 2 candidate labels.');
  }
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const label of labels) {
    if (typeof label !== 'string') {
      throw new Error('classify_text labels must all be strings.');
    }
    const trimmed = label.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  if (normalized.length < 2) {
    throw new Error(
      `classify_text needs at least 2 distinct, non-empty candidate labels (got ${normalized.length}). ` +
        'Zero-shot classification ranks labels against each other, so a single label has nothing to compare to.',
    );
  }
  return normalized;
}

/** null in single mode (nothing to filter by); the default or the override in multi mode. */
export function normalizeThreshold(threshold: number | undefined, mode: ClassificationMode): number | null {
  if (mode === 'single') return null;
  if (threshold === undefined) return DEFAULT_MULTI_LABEL_THRESHOLD;
  if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error(`classify_text "threshold" must be a number between 0 and 1 (got ${String(threshold)}).`);
  }
  return threshold;
}

/**
 * Pairs the pipeline's parallel labels/scores arrays and sorts them by
 * descending score. The pipeline already returns them sorted; sorting again
 * means this module's contract doesn't depend on that staying true.
 */
export function rankScores(labels: string[], scores: number[]): LabelScore[] {
  return labels.map((label, index) => ({ label, score: scores[index] ?? 0 })).sort((a, b) => b.score - a.score);
}

/**
 * Single mode (threshold null) selects the one best label; multi mode selects
 * every label at or above the threshold, which can legitimately be empty.
 */
export function selectLabels(allScores: LabelScore[], threshold: number | null): LabelScore[] {
  if (threshold === null) return allScores.slice(0, 1);
  return allScores.filter((entry) => entry.score >= threshold);
}
