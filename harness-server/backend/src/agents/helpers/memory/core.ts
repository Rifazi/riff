import { z } from 'zod';

// The read memory: every read_file result in a session, kept on disk so an
// agent (or a teammate, or the agent after a compaction) can `recall` the
// lines it needs instead of reading the file again. The local model never
// holds the memory; it only sees one budgeted slice of it per recall, and
// only picks line ranges, which are returned verbatim. Pure rules here,
// tested from frontend/tests/harness-server/read-memory-core.test.ts.

// Lines per searchable window: small enough that the engine never splits one.
export const WINDOW_LINES = 20;
// Candidates the local model reads per recall. The built-in Qwen runs with
// a 16k-token window; this leaves room for the prompt and the answer.
export const CANDIDATE_CHARS = 24_000;
// What one recall hands back to the paid agent.
export const MAX_RECALL_CHARS = 3_000;
// Lines of context kept around each range the model picks.
export const CONTEXT_LINES = 2;
// A read_file page: what a recall stands in for, at most (file-tools.ts).
export const READ_PAGE_CHARS = 16_000;
const CHARS_PER_TOKEN = 4;

export const NOT_IN_MEMORY = "Not in memory: nothing read in this session answers that. Read the file.";

export const recallSchema = z.object({
  question: z
    .string()
    .describe('What you need from code already read in this session, e.g. "the props of JobTable" or "where the job id is validated"'),
  paths: z
    .array(z.string())
    .optional()
    .describe('Only look in these repo-relative files or folders'),
});
export type RecallInput = z.infer<typeof recallSchema>;

export const recallDescription =
  'Get the exact lines you need from files already read in this session, by you before a context reset or by a ' +
  'teammate, without reading the file again. Returns the matching lines verbatim with path:line and whether the ' +
  'file has changed since it was read. Much cheaper than read_file for a file you have read before. If it says ' +
  'the lines are not in memory or the file changed, use read_file.';

export const MEMORY_NOTE =
  '\n\n# Read memory\n\nEvery file read in this session (by you, by earlier conversations of yours, and by your ' +
  "teammates or engineers on their branches) is kept in memory. Before reading a file again, call `recall` with " +
  'what you need from it: it returns just those lines, verbatim. Use read_file for files nobody has read yet, and ' +
  'when recall says the lines are missing or changed.';

/** Where a read was made: the main checkout ("session") or a team member's branch. */
export type MemoryView = string;
export const SESSION_VIEW: MemoryView = 'session';

export interface MemoryEntry {
  view: MemoryView;
  path: string;
  // sha1 of the whole file when it was read.
  fileHash: string;
  // [line number, text], sorted by line.
  lines: [number, string][];
  reader: string;
  readAt: string;
  usedAt: string;
}

export const entryKey = (view: MemoryView, path: string) => `${view}\u0000${normalizePath(path)}`;

export function normalizePath(p: string): string {
  return p.trim().replace(/^\.\//, '').replace(/\/+$/, '');
}

export function entryChars(entry: Pick<MemoryEntry, 'lines'>): number {
  return entry.lines.reduce((n, [, text]) => n + text.length + 1, 0);
}

/**
 * The lines a read_file result holds: a "[lines a-b of N …]" header then the
 * text, or the whole file with no header.
 */
export function parseReadText(text: string): { start: number; lines: string[] } {
  const header = /^\[lines (\d+)-\d+ of \d+[^\]\n]*\]\n/.exec(text);
  if (header) return { start: Number(header[1]), lines: text.slice(header[0].length).split('\n') };
  return { start: 1, lines: text.split('\n') };
}

/**
 * The entry after another read of the same file. A different file hash means
 * the file changed, so the old lines are dropped rather than mixed in.
 */
export function mergeRead(
  existing: MemoryEntry | undefined,
  read: { view: MemoryView; path: string; fileHash: string; start: number; lines: string[]; reader: string; at: string },
): MemoryEntry {
  const byLine = new Map<number, string>(existing && existing.fileHash === read.fileHash ? existing.lines : []);
  read.lines.forEach((text, i) => byLine.set(read.start + i, text));
  return {
    view: read.view,
    path: normalizePath(read.path),
    fileHash: read.fileHash,
    lines: [...byLine.entries()].sort((a, b) => a[0] - b[0]),
    reader: read.reader,
    readAt: read.at,
    usedAt: existing?.usedAt && existing.fileHash === read.fileHash ? existing.usedAt : read.at,
  };
}

/** Keys to drop, least recently used first, until the total fits `limit` chars. */
export function evictionOrder(entries: { key: string; chars: number; usedAt: string }[], limit: number): string[] {
  let total = entries.reduce((n, e) => n + e.chars, 0);
  const drop: string[] = [];
  for (const e of [...entries].sort((a, b) => a.usedAt.localeCompare(b.usedAt))) {
    if (total <= limit) break;
    drop.push(e.key);
    total -= e.chars;
  }
  return drop;
}

/** Runs of consecutive line numbers, e.g. 1-40 and 120-180 of a file read twice in pages. */
export function contiguousRuns(lines: [number, string][]): [number, string][][] {
  const runs: [number, string][][] = [];
  for (const line of lines) {
    const run = runs.at(-1);
    if (run && run.at(-1)![0] === line[0] - 1) run.push(line);
    else runs.push([line]);
  }
  return runs;
}

export const numbered = (lines: [number, string][]) => lines.map(([n, text]) => `${n}| ${text}`).join('\n');

/** The searchable windows of an entry: WINDOW_LINES lines each, headed "path:a-b". */
export function windows(entry: Pick<MemoryEntry, 'path' | 'lines'>): { heading: string; start: number; end: number; text: string }[] {
  const out: { heading: string; start: number; end: number; text: string }[] = [];
  for (const run of contiguousRuns(entry.lines)) {
    for (let i = 0; i < run.length; i += WINDOW_LINES) {
      const part = run.slice(i, i + WINDOW_LINES);
      const start = part[0][0];
      const end = part.at(-1)![0];
      out.push({ heading: `${entry.path}:${start}-${end}`, start, end, text: numbered(part) });
    }
  }
  return out;
}

export function parseHeading(heading: string | null | undefined): { path: string; start: number; end: number } | null {
  const m = /^(.*):(\d+)-(\d+)$/.exec(heading ?? '');
  return m ? { path: m[1], start: Number(m[2]), end: Number(m[3]) } : null;
}

export interface Candidate {
  key: string;
  path: string;
  view: MemoryView;
  start: number;
  end: number;
}

/** The candidates in rank order, deduplicated, up to `budget` chars of their numbered lines. */
export function packCandidates(ranked: Candidate[], entries: Map<string, MemoryEntry>, budget = CANDIDATE_CHARS): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  let used = 0;
  for (const c of ranked) {
    const id = `${c.key}:${c.start}`;
    if (seen.has(id)) continue;
    const entry = entries.get(c.key);
    if (!entry) continue;
    const chars = numbered(linesIn(entry, c.start, c.end)).length + c.path.length + 8;
    if (used + chars > budget) {
      if (out.length > 0) break;
      continue;
    }
    seen.add(id);
    out.push(c);
    used += chars;
  }
  return out;
}

export function linesIn(entry: Pick<MemoryEntry, 'lines'>, start: number, end: number): [number, string][] {
  return entry.lines.filter(([n]) => n >= start && n <= end);
}

export const PICK_SYSTEM =
  'You find where code excerpts answer a question. Reply with only the line ranges that answer it, one per line, ' +
  'as path:start-end, at most 4. Reply NONE if no excerpt answers it. Never write code or explanations.';

export function pickPrompt(question: string, candidates: Candidate[], entries: Map<string, MemoryEntry>): string {
  const blocks = candidates.map((c) => `### ${c.path}\n${numbered(linesIn(entries.get(c.key)!, c.start, c.end))}`);
  return `Question: ${question}\n\nExcerpts:\n\n${blocks.join('\n\n')}`;
}

export interface Excerpt {
  key: string;
  path: string;
  view: MemoryView;
  start: number;
  end: number;
}

/**
 * The ranges the model picked that really are in the candidates, widened by
 * CONTEXT_LINES and merged. Anything it made up is dropped. null = it said
 * NONE (or picked nothing real).
 */
export function groundPicks(answer: string, candidates: Candidate[], entries: Map<string, MemoryEntry>): Excerpt[] | null {
  const picks: Excerpt[] = [];
  // "path:a-b", or a bare "a-b" (small models often leave the path out),
  // which goes to the best-ranked candidate holding those lines.
  const ranges = /([\w@./-]*[\w@/-]):(\d+)(?:\s*-\s*(\d+))?|(?<![\w.:/-])(\d+)(?:\s*-\s*(\d+))?/g;
  for (const m of answer.matchAll(ranges)) {
    const a = Number(m[2] ?? m[4]);
    const end = m[3] ?? m[5];
    const b = end ? Number(end) : a;
    let matching: Candidate[];
    if (m[1]) {
      const pickPath = normalizePath(m[1]);
      matching = candidates.filter((x) => x.path === pickPath || x.path.endsWith(`/${pickPath}`));
    } else {
      const holder = candidates.find((x) => Math.max(a, b) >= x.start && Math.min(a, b) <= x.end);
      matching = holder ? candidates.filter((x) => x.key === holder.key) : [];
    }
    for (const c of matching) {
      const start = Math.max(Math.min(a, b), c.start);
      const end = Math.min(Math.max(a, b), c.end);
      if (start > end) continue;
      const entry = entries.get(c.key)!;
      const known = new Set(entry.lines.map(([n]) => n));
      let s = start;
      let e = end;
      for (let i = 0; i < CONTEXT_LINES && known.has(s - 1); i++) s--;
      for (let i = 0; i < CONTEXT_LINES && known.has(e + 1); i++) e++;
      picks.push({ key: c.key, path: c.path, view: c.view, start: s, end: e });
    }
  }
  return picks.length ? mergeExcerpts(picks) : null;
}

export function mergeExcerpts(excerpts: Excerpt[]): Excerpt[] {
  const sorted = [...excerpts].sort((x, y) => x.key.localeCompare(y.key) || x.start - y.start);
  const out: Excerpt[] = [];
  for (const e of sorted) {
    const last = out.at(-1);
    if (last && last.key === e.key && e.start <= last.end + 1) last.end = Math.max(last.end, e.end);
    else out.push({ ...e });
  }
  return out;
}

export type Freshness =
  | { kind: 'current' }
  | { kind: 'changed' }
  | { kind: 'other-view'; view: MemoryView }
  | { kind: 'missing' };

/** Whether an excerpt still matches the asker's checkout. */
export function freshness(entry: Pick<MemoryEntry, 'view' | 'fileHash'>, askerView: MemoryView, currentHash: string | null): Freshness {
  if (currentHash === null) return { kind: 'missing' };
  if (currentHash === entry.fileHash) return { kind: 'current' };
  return entry.view === askerView ? { kind: 'changed' } : { kind: 'other-view', view: entry.view };
}

export function freshnessLabel(f: Freshness, range: string): string {
  switch (f.kind) {
    case 'current':
      return 'current';
    case 'changed':
      return `changed since it was read: read_file ${range} before relying on it`;
    case 'other-view':
      return `as read on ${f.view === SESSION_VIEW ? 'the session branch' : f.view}; your checkout's copy differs`;
    case 'missing':
      return 'no longer in your checkout';
  }
}

/** The excerpts verbatim, each headed with its range and freshness, cut to `max` chars on a line boundary. */
export function formatRecall(
  excerpts: { excerpt: Excerpt; lines: [number, string][]; label: string }[],
  max = MAX_RECALL_CHARS,
): string {
  const parts: string[] = [];
  let used = 0;
  for (const { excerpt, lines, label } of excerpts) {
    const head = `${excerpt.path}:${excerpt.start}-${excerpt.end} (${label})`;
    const body: string[] = [];
    let size = head.length + 1;
    for (const line of lines) {
      const text = `${line[0]}| ${line[1]}`;
      if (used + size + text.length + 1 > max) break;
      body.push(text);
      size += text.length + 1;
    }
    if (body.length === 0) break;
    parts.push(`${head}\n${body.join('\n')}`);
    used += size + 2;
  }
  return parts.join('\n\n');
}

/**
 * What a recall saved the paid agent: the reads it stood in for (each file's
 * stored lines, at most one read_file page) minus what it returned. A lower
 * bound, like the research helper's, since a read stays in context.
 */
export function recallSavedTokens(storedChars: number[], returnedChars: number): number {
  const replaced = storedChars.reduce((n, c) => n + Math.min(c, READ_PAGE_CHARS), 0);
  return Math.max(0, Math.round((replaced - returnedChars) / CHARS_PER_TOKEN));
}

/** Keyword fallback when the search engine isn't available: windows ranked by distinct query terms they contain. */
export function rankByTerms(
  question: string,
  entries: MemoryEntry[],
): Candidate[] {
  const terms = [...new Set(question.toLowerCase().match(/[a-z_$][\w$]{2,}/g) ?? [])];
  if (!terms.length) return [];
  const scored: { c: Candidate; score: number }[] = [];
  for (const entry of entries) {
    for (const w of windows(entry)) {
      const text = w.text.toLowerCase();
      const score = terms.filter((t) => text.includes(t)).length;
      if (score > 0) {
        scored.push({ c: { key: entryKey(entry.view, entry.path), path: entry.path, view: entry.view, start: w.start, end: w.end }, score });
      }
    }
  }
  return scored.sort((a, b) => b.score - a.score).map((s) => s.c);
}
