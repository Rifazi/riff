import { promises as fs } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import type { AppConfig } from '../apps/apps.js';
import { listIndexedFiles, readDocSection } from '../repo/docs-index.js';
import { generateLocal, localModelStatus } from '../agents/local-llm.js';
import { cleanModelSummary, hashText, ruleSummary, type DocEntry } from './docs-map.js';

// The shared context agent. It reads the repo's markdown docs once, keeps a
// one-line summary of each (written by Riff's built-in Qwen when it's
// installed, else taken from the doc's own first sentence) and hands every
// role the same map instead of each agent searching and opening docs to
// find out what exists. Summaries are cached by content hash, so a doc is
// re-read by the model only when it changes. The model never blocks a
// turn: a doc without a model summary shows its rule-made one until the
// background pass replaces it.

const SUMMARY_SYSTEM =
  'You write one-line summaries of repository documentation for software engineers. Reply with one or two ' +
  'sentences, at most 40 words: what the doc covers and when someone needs to read it. No preamble, no markdown.';
const MODEL_INPUT_CHARS = 6000;
const MAX_UPGRADES_PER_RUN = 40;

interface Cache {
  docs: Record<string, DocEntry>;
}

const caches = new Map<string, Cache>();
const upgrading = new Map<string, Promise<void>>();

const cachePath = (appId: string) => path.join(config.stateDir, 'app-context', `${appId.replace(/[^\w.-]/g, '_')}.json`);

async function loadCache(appId: string): Promise<Cache> {
  const held = caches.get(appId);
  if (held) return held;
  let cache: Cache = { docs: {} };
  try {
    const parsed = JSON.parse(await fs.readFile(cachePath(appId), 'utf8')) as Cache;
    if (parsed && typeof parsed.docs === 'object') cache = parsed;
  } catch {
    // no cache yet, or unreadable: start empty
  }
  caches.set(appId, cache);
  return cache;
}

async function saveCache(appId: string, cache: Cache): Promise<void> {
  try {
    await fs.mkdir(path.dirname(cachePath(appId)), { recursive: true });
    await fs.writeFile(cachePath(appId), JSON.stringify(cache, null, 1));
  } catch {
    // derived data: it is rebuilt from the docs
  }
}

/**
 * The map for an app, up to date with the docs index. New and edited docs
 * get their rule-made summary at once; the model upgrades them in the
 * background (`ensureSummaries`).
 */
export async function appContext(app: AppConfig): Promise<DocEntry[]> {
  const cache = await loadCache(app.id);
  const files = listIndexedFiles(app.id);
  const entries: DocEntry[] = [];
  const live = new Set<string>();
  let changed = false;
  for (const file of files) {
    const text = readDocSection(app.id, file);
    if (text === null) continue;
    live.add(file);
    const hash = hashText(text);
    const held = cache.docs[file];
    if (held && held.hash === hash) {
      entries.push(held);
      continue;
    }
    const entry: DocEntry = { path: file, hash, summary: ruleSummary(text) || file, by: 'rule' };
    cache.docs[file] = entry;
    entries.push(entry);
    changed = true;
  }
  for (const file of Object.keys(cache.docs)) {
    if (!live.has(file)) {
      delete cache.docs[file];
      changed = true;
    }
  }
  if (changed) await saveCache(app.id, cache);
  if (entries.some((e) => e.by === 'rule') && localModelStatus().available) void ensureSummaries(app);
  return entries;
}

/** One background pass of model summaries for the docs that only have a rule-made one. */
export function ensureSummaries(app: AppConfig): Promise<void> {
  const running = upgrading.get(app.id);
  if (running) return running;
  const run = (async () => {
    const cache = await loadCache(app.id);
    const todo = Object.values(cache.docs).filter((e) => e.by === 'rule').slice(0, MAX_UPGRADES_PER_RUN);
    for (const entry of todo) {
      const text = readDocSection(app.id, entry.path);
      if (text === null || hashText(text) !== entry.hash) continue;
      try {
        const reply = await generateLocal({
          system: SUMMARY_SYSTEM,
          prompt: `File: ${entry.path}\n\n${text.slice(0, MODEL_INPUT_CHARS)}`,
          maxTokens: 120,
        });
        const summary = cleanModelSummary(reply);
        const current = cache.docs[entry.path];
        if (summary && current && current.hash === entry.hash) cache.docs[entry.path] = { ...current, summary, by: 'local' };
      } catch (err) {
        console.warn('[app-context] local summary failed, keeping rule summaries —', err instanceof Error ? err.message : err);
        break;
      }
    }
    await saveCache(app.id, cache);
  })().finally(() => upgrading.delete(app.id));
  upgrading.set(app.id, run);
  return run;
}

export function forgetAppContext(appId: string): void {
  caches.delete(appId);
  void fs.rm(cachePath(appId), { force: true });
}
