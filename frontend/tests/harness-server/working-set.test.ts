import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  editedRanges,
  lastListing,
  renderWorkingSet,
  workingSetRanges,
} from '../../../harness-server/backend/src/agents/working-set';

const call = (toolName: string, toolInput: Record<string, unknown>, id: string) => ({ role: 'tool_call', toolName, toolInput, toolCallId: id });
const result = (text: string, id: string, isError = false) => ({ role: 'tool_result', toolResult: [{ type: 'text', text }], toolCallId: id, isError });

// After a mid-step cut, agents spent a median of 15 calls re-reading what
// they had just read and edited: the handoff now carries those ranges.
describe('workingSetRanges', () => {
  test('reads, edits and writes, newest file first, ranges merged', () => {
    const entries = [
      call('mcp__harness-tools__read_file', { path: 'a.ts', offset: 10, limit: 20 }, '1'),
      result('[lines 10-29 of 900]\n…', '1'),
      call('read_file', { path: 'b.ts' }, '2'),
      result('whole b', '2'),
      call('edit_file', { path: 'a.ts', oldText: 'x', newText: 'y' }, '3'),
      result('Edited a.ts (lines 25-27 of 900)', '3'),
      call('write_file', { path: 'c.ts', content: '…' }, '4'),
      result('Wrote c.ts (12 lines)', '4'),
    ];
    expect(workingSetRanges(entries)).toEqual([
      { path: 'c.ts', start: 1, end: 300 },
      { path: 'a.ts', start: 10, end: 32 },
      { path: 'b.ts', start: 1, end: 300 },
    ]);
  });

  test('a symbol read uses the range its result names', () => {
    const entries = [call('read_file', { path: 'a.ts', symbol: 'parse' }, '1'), result('[parse: lines 40-58.]\nfunction parse() {}', '1')];
    expect(workingSetRanges(entries)).toEqual([{ path: 'a.ts', start: 40, end: 58 }]);
  });

  test('leaves out failed calls, repeat notes and deleted files', () => {
    const entries = [
      call('edit_file', { path: 'a.ts' }, '1'),
      result('oldText not found in a.ts', '1', true),
      call('read_file', { path: 'b.ts' }, '2'),
      result('[b.ts is unchanged since you last read it in this conversation — use that copy.]', '2'),
      call('read_file', { path: 'gone.ts' }, '3'),
      result('text', '3'),
      call('delete_file', { path: 'gone.ts' }, '4'),
      result('Deleted gone.ts', '4'),
    ];
    expect(workingSetRanges(entries)).toEqual([]);
  });

  test('pairs results by id when parallel calls finish out of order', () => {
    const entries = [
      call('read_file', { path: 'a.ts', offset: 5, limit: 5 }, '1'),
      call('edit_file', { path: 'b.ts' }, '2'),
      result('Edited b.ts (lines 7-7 of 50)', '2'),
      result('[lines 5-9 of 50]', '1'),
    ];
    expect(workingSetRanges(entries)).toEqual([
      { path: 'b.ts', start: 2, end: 12 },
      { path: 'a.ts', start: 5, end: 9 },
    ]);
  });
});

test('editedRanges reads every edit of a multi-edit result', () => {
  expect(editedRanges('Edited a.ts (lines 3-4, removed at line 9, lines 20-22 of 40)')).toEqual([
    [3, 4],
    [9, 9],
    [20, 22],
  ]);
});

describe('renderWorkingSet', () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), 'working-set-'));
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  test('shows the ranges as they are on disk now', () => {
    mkdirSync(path.join(repo, 'src'));
    writeFileSync(path.join(repo, 'src/a.ts'), Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n'));
    const text = renderWorkingSet(repo, [call('read_file', { path: 'src/a.ts', offset: 3, limit: 2 }, '1'), result('…', '1')]);
    expect(text).toContain('## Where you were working');
    expect(text).toContain('### src/a.ts — lines 3-4 of 50');
    expect(text).toContain('line 3\nline 4\n```');
    expect(text).not.toContain('line 5');
  });

  test('nothing for a conversation that read nothing that still exists', () => {
    expect(renderWorkingSet(repo, [call('read_file', { path: 'missing.ts' }, '1'), result('…', '1')])).toBe('');
  });

  test('caps what one range shows', () => {
    writeFileSync(path.join(repo, 'big.ts'), Array.from({ length: 300 }, () => 'x'.repeat(100)).join('\n'));
    const text = renderWorkingSet(repo, [call('read_file', { path: 'big.ts' }, '1'), result('…', '1')]);
    expect(text.length).toBeLessThan(4_600);
  });
});

test('lastListing returns the last match-all search_code result', () => {
  const entries = [
    call('search_code', { query: '.', glob: 'src/**' }, '1'),
    result('A pattern that matches every line only lists files. 3 under "src":\nsrc/a.ts', '1'),
    call('search_code', { query: 'parse' }, '2'),
    result('src/a.ts\n  3: parse', '2'),
  ];
  expect(lastListing(entries)).toContain('(glob "src/**")');
  expect(lastListing(entries)).toContain('src/a.ts');
  expect(lastListing([call('search_code', { query: 'parse' }, '2'), result('x', '2')])).toBeNull();
});
