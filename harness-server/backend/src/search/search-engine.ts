import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { config } from '../config.js';
import { riffDataDir, riffEnv, riffRoot } from '../riff-paths.js';

// Riff's search engine (<riff>/search, the `riff-search` crate): the same
// code behind the app's meeting and journal search. Keyword search (SQLite
// FTS5, stemmed, BM25) fused with search by meaning (local embeddings) when
// Riff's embedding model is downloaded. Runs as a child process speaking
// one JSON object per line (see search/src/stdio.rs): Riff passes its own
// binary as RIFF_SEARCH_BIN (`riff --search-stdio`); without the app, a
// built riff-search or riff binary in <riff>/target is used.

export interface SearchSegment {
  text: string;
  heading?: string;
}

export interface SearchDocument {
  key: string;
  kind: string;
  title: string;
  fingerprint: string;
  segments: SearchSegment[];
}

export interface SearchHit {
  scope: string;
  key: string;
  kind: string;
  title: string;
  heading: string | null;
  text: string;
  snippet: string;
  score: number;
  keyword: boolean;
  semantic: boolean;
}

export interface SearchQuery {
  text: string;
  scopes: string[];
  kinds?: string[];
  limit?: number;
  grouped?: boolean;
}

const REQUEST_TIMEOUT_MS = 60_000;
const UPSERT_BATCH = 50;

function resolveBinary(): string | null {
  const exe = process.platform === 'win32' ? '.exe' : '';
  const root = riffRoot();
  const candidates = [
    riffEnv('SEARCH_BIN'),
    path.join(root, 'target/release', `riff-search${exe}`),
    path.join(root, 'target/debug', `riff-search${exe}`),
    path.join(root, 'target/debug', `riff${exe}`),
    path.join(root, 'target/release', `riff${exe}`),
    process.platform === 'darwin' ? '/Applications/Riff.app/Contents/MacOS/riff' : undefined,
  ];
  return candidates.find((p): p is string => Boolean(p && existsSync(p))) ?? null;
}

export class SearchUnavailableError extends Error {}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

let child: ChildProcessWithoutNullStreams | null = null;
const pending = new Map<number, Pending>();
let nextId = 1;

function failAll(error: Error): void {
  for (const p of pending.values()) {
    clearTimeout(p.timer);
    p.reject(error);
  }
  pending.clear();
}

function ensureStarted(): ChildProcessWithoutNullStreams {
  if (child) return child;
  const bin = resolveBinary();
  if (!bin) {
    throw new SearchUnavailableError(
      "Riff's search engine was not found. Build Riff once (or `cargo build -p riff-search`), or set RIFF_SEARCH_BIN."
    );
  }
  const modelsDir = riffEnv('EMBEDDING_MODELS_DIR') ?? path.join(riffDataDir(), 'models/embeddings');
  // `--search-stdio` selects the mode in the app binary; riff-search ignores it.
  const proc = spawn(bin, ['--search-stdio', '--index', path.join(config.stateDir, 'search.sqlite'), '--model-dir', modelsDir], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  createInterface({ input: proc.stdout }).on('line', (line) => {
    let message: { id?: number; ok?: boolean; result?: unknown; error?: string };
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const waiting = message.id !== undefined ? pending.get(message.id) : undefined;
    if (!waiting) return;
    pending.delete(message.id!);
    clearTimeout(waiting.timer);
    if (message.ok) waiting.resolve(message.result);
    else waiting.reject(new Error(message.error ?? 'search failed'));
  });
  // Its log goes to ours only when something is wrong.
  createInterface({ input: proc.stderr }).on('line', (line) => {
    if (/\b(WARN|ERROR)\b|error:/i.test(line)) console.warn(`[search] ${line}`);
  });
  proc.on('exit', (code, signal) => {
    if (child === proc) child = null;
    failAll(new Error(`search engine exited (${signal ?? code})`));
  });
  proc.on('error', (err) => {
    if (child === proc) child = null;
    failAll(err);
  });
  child = proc;
  return proc;
}

function request<T>(op: string, fields: Record<string, unknown> = {}): Promise<T> {
  const proc = ensureStarted();
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`search engine timed out on ${op}`));
    }, REQUEST_TIMEOUT_MS);
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
    proc.stdin.write(`${JSON.stringify({ id, op, ...fields })}\n`);
  });
}

export function fingerprint(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

// Per scope: the fingerprints last synced, so an unchanged scope costs no
// round trip, and the sync in flight, so concurrent searches share it.
const syncedSignature = new Map<string, string>();
const syncing = new Map<string, Promise<void>>();

/** Makes the engine's `scope` hold exactly `docs`, re-indexing only changed ones. */
export function syncScope(scope: string, docs: SearchDocument[]): Promise<void> {
  const signature = docs.map((d) => `${d.key}\u0000${d.fingerprint}`).sort().join('\u0001');
  if (syncedSignature.get(scope) === signature) return Promise.resolve();
  const previous = syncing.get(scope) ?? Promise.resolve();
  const run = previous
    .catch(() => undefined)
    .then(async () => {
      if (syncedSignature.get(scope) === signature) return;
      const indexed = await request<Record<string, string>>('fingerprints', { scope });
      const changed = docs.filter((d) => indexed[d.key] !== d.fingerprint);
      const wanted = new Set(docs.map((d) => d.key));
      const removed = Object.keys(indexed).filter((key) => !wanted.has(key));
      for (let i = 0; i < changed.length; i += UPSERT_BATCH) {
        await request('upsert', { scope, docs: changed.slice(i, i + UPSERT_BATCH) });
      }
      if (removed.length > 0) await request('remove', { scope, keys: removed });
      syncedSignature.set(scope, signature);
    });
  syncing.set(scope, run);
  return run.finally(() => {
    if (syncing.get(scope) === run) syncing.delete(scope);
  });
}

export function searchIndex(query: SearchQuery): Promise<SearchHit[]> {
  return request<SearchHit[]>('search', { query: { limit: 10, grouped: false, kinds: [], ...query } });
}

/** Drops a scope that no longer exists (a deleted app or session). Best effort. */
export function forgetScope(scope: string): void {
  syncedSignature.delete(scope);
  try {
    request('remove_scope', { scope }).catch(() => undefined);
  } catch {
    // Engine unavailable: nothing was indexed either.
  }
}

/** Stops the engine (server shutdown). */
export function stopSearchEngine(): void {
  child?.kill();
  child = null;
}
