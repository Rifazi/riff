import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createFileExecutors } from '../../../harness-server/backend/src/agents/tool-defs/file-tools';
import { symbolRanges } from '../../../harness-server/backend/src/agents/tool-defs/symbol-range';

const SOURCE = `import { x } from './x';

export const SEGMENTS = {
  N1: {
    name: 'Name',
  },
  REF: { name: 'Reference' },
};

export function parse(text: string): string {
  return text;
}

class Store {
  get(id: string) {
    return id;
  }
}

describe('parse', () => {
  it('keeps text', () => {
    expect(parse('a')).toBe('a');
  });
});
`;

// read_file's `symbol` returns just a declaration in one call, where agents
// outlined or searched first and then read the range.
describe('symbolRanges', () => {
  test('functions, object keys, methods and test names', () => {
    expect(symbolRanges(SOURCE, 'a.ts', 'parse')).toEqual([{ start: 10, end: 12, label: 'parse' }, { start: 20, end: 24, label: 'parse' }]);
    expect(symbolRanges(SOURCE, 'a.ts', 'N1')).toEqual([{ start: 4, end: 6, label: 'N1 (in SEGMENTS)' }]);
    expect(symbolRanges(SOURCE, 'a.ts', 'SEGMENTS')[0]).toEqual({ start: 3, end: 8, label: 'SEGMENTS' });
    expect(symbolRanges(SOURCE, 'a.ts', 'Store.get')).toEqual([{ start: 15, end: 17, label: 'get (in Store)' }]);
    expect(symbolRanges(SOURCE, 'a.ts', 'keeps text')).toEqual([{ start: 21, end: 23, label: 'keeps text (in parse)' }]);
  });

  test('an owner that does not enclose it matches nothing', () => {
    expect(symbolRanges(SOURCE, 'a.ts', 'SEGMENTS.get')).toEqual([]);
  });

  test('a markdown heading runs to the next heading at its level or above', () => {
    const md = '# Doc\n\n## Setup\n\ntext\n\n### Detail\n\nmore\n\n## Usage\n\nend\n';
    expect(symbolRanges(md, 'docs/a.md', 'Setup')).toEqual([{ start: 3, end: 10, label: 'Setup' }]);
  });

  test('other file types have no symbols', () => {
    expect(symbolRanges('{"a": 1}', 'a.json', 'a')).toEqual([]);
  });
});

describe('read_file with symbol', () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), 'symbol-read-'));
    writeFileSync(path.join(repo, 'a.ts'), SOURCE);
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  test('returns just the declaration, with where it is', async () => {
    const reads: string[] = [];
    const { readFileExecute } = createFileExecutors({ repoRoot: repo, onRead: (_p, r) => reads.push(r.text) });
    const text = await readFileExecute({ path: 'a.ts', symbol: 'N1' });
    expect(text).toStartWith('[N1 (in SEGMENTS): lines 4-6.]\n[lines 4-6 of 25');
    expect(text).toContain("    name: 'Name',");
    expect(text).not.toContain('REF');
    expect(reads[0]).toStartWith('[lines 4-6 of 25');
  });

  test('names the other declarations of the same name', async () => {
    const { readFileExecute } = createFileExecutors({ repoRoot: repo });
    expect(await readFileExecute({ path: 'a.ts', symbol: 'parse' })).toContain('Also declared at lines 20-24.');
  });

  test('a missing symbol fails with the outline', async () => {
    const { readFileExecute } = createFileExecutors({ repoRoot: repo });
    await expect(readFileExecute({ path: 'a.ts', symbol: 'nope' })).rejects.toThrow('No declaration named "nope" in a.ts. Its outline');
  });
});
