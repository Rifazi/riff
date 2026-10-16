import { describe, expect, test } from 'bun:test';

import {
  CANDIDATE_CHARS,
  entryKey,
  evictionOrder,
  formatRecall,
  freshness,
  freshnessLabel,
  groundPicks,
  mergeRead,
  packCandidates,
  parseHeading,
  parseReadText,
  rankByTerms,
  recallSavedTokens,
  SESSION_VIEW,
  WHOLE_FILES_CHARS,
  asksForWholeFile,
  wholeFileExcerpts,
  windows,
  type MemoryEntry,
} from '../../../harness-server/backend/src/agents/helpers/memory/core';

const read = (start: number, lines: string[], fileHash = 'h1') => ({
  view: SESSION_VIEW,
  path: 'src/jobs.ts',
  fileHash,
  start,
  lines,
  reader: 'coding',
  at: '2026-10-10T00:00:00Z',
});
const lines = (from: number, count: number) => Array.from({ length: count }, (_, i) => `line ${from + i}`);

describe('what a read_file result holds', () => {
  test('a page carries its first line in the header', () => {
    expect(parseReadText('[lines 40-41 of 300 — more remains, pass offset: 42 to continue]\na\nb')).toEqual({ start: 40, lines: ['a', 'b'] });
  });

  test('a whole small file starts at line 1', () => {
    expect(parseReadText('a\nb')).toEqual({ start: 1, lines: ['a', 'b'] });
  });
});

describe('remembering reads', () => {
  test('pages of the same file version merge', () => {
    const first = mergeRead(undefined, read(1, lines(1, 3)));
    const both = mergeRead(first, read(10, lines(10, 2)));
    expect(both.lines.map(([n]) => n)).toEqual([1, 2, 3, 10, 11]);
  });

  test('a changed file replaces the old lines instead of mixing versions', () => {
    const first = mergeRead(undefined, read(1, lines(1, 3)));
    const changed = mergeRead(first, read(10, ['new'], 'h2'));
    expect(changed.lines).toEqual([[10, 'new']]);
    expect(changed.fileHash).toBe('h2');
  });

  test('eviction drops the least recently used until it fits', () => {
    const entries = [
      { key: 'a', chars: 50, usedAt: '2026-10-10T03:00:00Z' },
      { key: 'b', chars: 50, usedAt: '2026-10-10T01:00:00Z' },
      { key: 'c', chars: 50, usedAt: '2026-10-10T02:00:00Z' },
    ];
    expect(evictionOrder(entries, 100)).toEqual(['b']);
    expect(evictionOrder(entries, 150)).toEqual([]);
  });
});

describe('searchable windows', () => {
  test('keep exact line ranges and never span a gap between reads', () => {
    const entry = mergeRead(mergeRead(undefined, read(1, lines(1, 25))), read(100, lines(100, 5)));
    const w = windows(entry);
    expect(w.map((x) => x.heading)).toEqual(['src/jobs.ts:1-20', 'src/jobs.ts:21-25', 'src/jobs.ts:100-104']);
    expect(w[2].text.split('\n')[0]).toBe('100| line 100');
    expect(parseHeading(w[1].heading)).toEqual({ path: 'src/jobs.ts', start: 21, end: 25 });
  });
});

describe('picking lines', () => {
  const entry: MemoryEntry = mergeRead(undefined, read(1, lines(1, 40)));
  const key = entryKey(SESSION_VIEW, 'src/jobs.ts');
  const entries = new Map([[key, entry]]);
  const candidates = [{ key, path: 'src/jobs.ts', view: SESSION_VIEW, start: 1, end: 20 }];

  test('a picked range is widened by two lines of context, inside what was read', () => {
    expect(groundPicks('src/jobs.ts:10-12', candidates, entries)).toEqual([
      { key, path: 'src/jobs.ts', view: SESSION_VIEW, start: 8, end: 14 },
    ]);
  });

  test('ranges outside the candidates, or made up, are dropped', () => {
    expect(groundPicks('src/jobs.ts:30-35', candidates, entries)).toBeNull();
    expect(groundPicks('src/other.ts:1-5', candidates, entries)).toBeNull();
    expect(groundPicks('NONE', candidates, entries)).toBeNull();
  });

  test('a shortened path still matches', () => {
    expect(groundPicks('jobs.ts:3', candidates, entries)?.[0]).toMatchObject({ start: 1, end: 5 });
  });

  test('candidates stop at the budget the local model can read', () => {
    const big: MemoryEntry = mergeRead(undefined, read(1, Array.from({ length: 2000 }, () => 'x'.repeat(80))));
    const bigEntries = new Map([[key, big]]);
    const ranked = Array.from({ length: 100 }, (_, i) => ({ key, path: 'src/jobs.ts', view: SESSION_VIEW, start: i * 20 + 1, end: i * 20 + 20 }));
    const packed = packCandidates(ranked, bigEntries);
    expect(packed.length).toBeGreaterThan(0);
    expect(packed.length * 20 * 85).toBeLessThanOrEqual(CANDIDATE_CHARS);
  });

  test('the keyword fallback ranks windows by query terms', () => {
    const e = mergeRead(undefined, read(1, ['function validateJobId(id) {', 'return id;', ...lines(3, 30)]));
    expect(rankByTerms('where is validateJobId', [e])[0]).toMatchObject({ start: 1, end: 20 });
  });
});

describe('freshness', () => {
  const entry = { view: SESSION_VIEW, fileHash: 'h1' };
  test('current, changed, another branch, or gone', () => {
    expect(freshness(entry, SESSION_VIEW, 'h1')).toEqual({ kind: 'current' });
    expect(freshnessLabel(freshness(entry, SESSION_VIEW, 'h2'), 'a.ts:1-5')).toContain('read_file a.ts:1-5');
    expect(freshnessLabel(freshness(entry, 'feat--api', 'h2'), 'a.ts:1-5')).toContain('as read on the session branch');
    expect(freshness(entry, SESSION_VIEW, null)).toEqual({ kind: 'missing' });
  });
});

test('a recall is cut on a line boundary and never claims a saving it did not make', () => {
  const excerpt = { key: 'k', path: 'a.ts', view: SESSION_VIEW, start: 1, end: 100 };
  const text = formatRecall([{ excerpt, lines: Array.from({ length: 100 }, (_, i) => [i + 1, 'y'.repeat(60)] as [number, string]), label: 'current' }], 500);
  expect(text.length).toBeLessThanOrEqual(500);
  expect(text.split('\n').every((l, i) => i === 0 || /^\d+\| /.test(l))).toBe(true);
  expect(recallSavedTokens([100], 400)).toBe(0);
  expect(recallSavedTokens([100_000], 0)).toBe(4_000);
});

test('a bare range without a path goes to the best-ranked candidate holding it', () => {
  const key = entryKey(SESSION_VIEW, 'src/jobs.ts');
  const entries = new Map([[key, mergeRead(undefined, read(1, lines(1, 40)))]]);
  const candidates = [
    { key, path: 'src/jobs.ts', view: SESSION_VIEW, start: 21, end: 40 },
    { key, path: 'src/jobs.ts', view: SESSION_VIEW, start: 1, end: 20 },
  ];
  expect(groundPicks('22-24', candidates, entries)?.[0]).toMatchObject({ start: 20, end: 26 });
  expect(groundPicks('src/jobs.ts:5', candidates, entries)?.[0]).toMatchObject({ start: 3, end: 7 });
  expect(groundPicks('99-120', candidates, entries)).toBeNull();
});

// A few small named files come back whole: half of all recalls were
// followed by a read_file of the same file.
describe('wholeFileExcerpts', () => {
  const entry = (path: string, lines: [number, string][]): [string, MemoryEntry] => [
    entryKey(SESSION_VIEW, path),
    { view: SESSION_VIEW, path, fileHash: 'h', lines, reader: 'coding', readAt: 't', usedAt: 't' },
  ];
  const small = entry('src/a.ts', [[1, 'export const a = 1;'], [2, 'export const b = 2;']]);
  const bigLines: [number, string][] = Array.from({ length: 200 }, (_, i) => [i + 1, 'x'.repeat(60)]);
  const big = entry('src/big.ts', bigLines);

  test('recognises questions that want the whole file', () => {
    expect(asksForWholeFile('full contents of types.ts: CodeListEntry and helpers')).toBe(true);
    expect(asksForWholeFile('the entire file')).toBe(true);
    expect(asksForWholeFile('the ElementDataType union definition (lines around 43-49)')).toBe(false);
  });

  test('a small named file is returned whole, one excerpt per contiguous run', () => {
    const out = wholeFileExcerpts('what does a export', new Map([small]), true);
    expect(out).toEqual([{ key: small[0], path: 'src/a.ts', view: SESSION_VIEW, start: 1, end: 2 }]);
    const paged = entry('src/p.ts', [[1, 'a'], [2, 'b'], [10, 'c']]);
    expect(wholeFileExcerpts('q', new Map([paged]), true)?.map((e) => [e.start, e.end])).toEqual([[1, 2], [10, 10]]);
  });

  test('only when files were named, and only when they fit', () => {
    expect(wholeFileExcerpts('q', new Map([small]), false)).toBeNull();
    expect(bigLines.length * 61).toBeGreaterThan(WHOLE_FILES_CHARS);
    expect(wholeFileExcerpts('where is x', new Map([big]), true)).toBeNull();
    expect(wholeFileExcerpts('full contents of big.ts', new Map([big]), true)).toHaveLength(1);
    const four = new Map([small, big, entry('c.ts', [[1, 'c']]), entry('d.ts', [[1, 'd']])]);
    expect(wholeFileExcerpts('full contents', four, true)).toBeNull();
  });
});
