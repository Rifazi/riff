import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { config } from '../../../config.js';
import { forgetScope } from '../../../search/search-engine.js';
import { entryChars, entryKey, evictionOrder, mergeRead, type MemoryEntry, type MemoryView } from './core.js';

// The read memory on disk: state/read-memory/<sessionId>/<sha1(key)>.json,
// one file per (view, path), loaded once per process and written through.
// Everything for a session goes through one queue, since its agents read
// concurrently.

// Per session, in characters of stored lines (~8 MB).
export const MEMORY_LIMIT_CHARS = 8_000_000;

const rootDir = () => path.join(config.stateDir, 'read-memory');
const sessionDir = (sessionId: string) => path.join(rootDir(), sessionId);
const fileFor = (sessionId: string, key: string) =>
  path.join(sessionDir(sessionId), `${createHash('sha1').update(key).digest('hex')}.json`);

export const memorySearchScope = (sessionId: string) => `memory:session:${sessionId}`;

const loaded = new Map<string, Promise<Map<string, MemoryEntry>>>();
const queues = new Map<string, Promise<unknown>>();

function enqueue<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const run = (queues.get(sessionId) ?? Promise.resolve()).catch(() => undefined).then(fn);
  queues.set(sessionId, run);
  return run;
}

async function load(sessionId: string): Promise<Map<string, MemoryEntry>> {
  let entries = loaded.get(sessionId);
  if (!entries) {
    entries = (async () => {
      const map = new Map<string, MemoryEntry>();
      const names = await fs.readdir(sessionDir(sessionId)).catch(() => [] as string[]);
      for (const name of names.filter((n) => n.endsWith('.json'))) {
        try {
          const entry = JSON.parse(await fs.readFile(path.join(sessionDir(sessionId), name), 'utf8')) as MemoryEntry;
          map.set(entryKey(entry.view, entry.path), entry);
        } catch {
          // A file cut off mid-write: that read is just not remembered.
        }
      }
      return map;
    })();
    loaded.set(sessionId, entries);
  }
  return entries;
}

async function save(sessionId: string, key: string, entry: MemoryEntry): Promise<void> {
  await fs.mkdir(sessionDir(sessionId), { recursive: true });
  const file = fileFor(sessionId, key);
  await fs.writeFile(`${file}.tmp`, JSON.stringify(entry));
  await fs.rename(`${file}.tmp`, file);
}

/** Remembers one read_file result. Never throws: memory must not fail the read. */
export function recordRead(
  sessionId: string,
  read: { view: MemoryView; path: string; fileHash: string; start: number; lines: string[]; reader: string },
): Promise<void> {
  return enqueue(sessionId, async () => {
    const entries = await load(sessionId);
    const key = entryKey(read.view, read.path);
    const entry = mergeRead(entries.get(key), { ...read, at: new Date().toISOString() });
    entries.set(key, entry);
    await save(sessionId, key, entry);
    const drop = evictionOrder(
      [...entries].map(([k, e]) => ({ key: k, chars: entryChars(e), usedAt: e.usedAt })),
      MEMORY_LIMIT_CHARS,
    );
    for (const k of drop) {
      entries.delete(k);
      await fs.rm(fileFor(sessionId, k), { force: true });
    }
  }).catch((err) => console.warn('[read-memory] could not record a read —', err instanceof Error ? err.message : err));
}

/** Every remembered read in the session. */
export function memoryEntries(sessionId: string): Promise<Map<string, MemoryEntry>> {
  return enqueue(sessionId, () => load(sessionId));
}

/** Marks entries as just recalled, so eviction keeps them longest. */
export function touchEntries(sessionId: string, keys: string[]): Promise<void> {
  return enqueue(sessionId, async () => {
    const entries = await load(sessionId);
    const now = new Date().toISOString();
    for (const key of new Set(keys)) {
      const entry = entries.get(key);
      if (!entry) continue;
      entry.usedAt = now;
      await save(sessionId, key, entry);
    }
  }).catch(() => undefined);
}

/** Deletes a session's memory (session deletion). */
export function removeReadMemory(sessionId: string): Promise<void> {
  return enqueue(sessionId, async () => {
    loaded.delete(sessionId);
    await fs.rm(sessionDir(sessionId), { recursive: true, force: true });
    forgetScope(memorySearchScope(sessionId));
  });
}

/** Sessions with memory and its size on disk, for Settings. */
export async function readMemoryStatus(): Promise<{ sessions: number; bytes: number }> {
  let sessions = 0;
  let bytes = 0;
  for (const dir of await fs.readdir(rootDir()).catch(() => [] as string[])) {
    const names = await fs.readdir(path.join(rootDir(), dir)).catch(() => [] as string[]);
    if (names.length) sessions++;
    for (const name of names) {
      bytes += (await fs.stat(path.join(rootDir(), dir, name)).catch(() => null))?.size ?? 0;
    }
  }
  return { sessions, bytes };
}

/** Deletes every session's memory (Settings → Clear). */
export async function clearReadMemory(): Promise<void> {
  for (const dir of await fs.readdir(rootDir()).catch(() => [] as string[])) await removeReadMemory(dir);
}
