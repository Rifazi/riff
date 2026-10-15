import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createFileExecutors } from '../../../harness-server/backend/src/agents/tool-defs/file-tools';

// write_file and edit_file hand the whole file as written to onWrite, which the
// read memory files as read: after a context reset, `recall` answered "Not in
// memory" for files the agent had written and it read every one of them again.
describe('onWrite', () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), 'file-tools-'));
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  test('gets the whole file after a write and after an edit', async () => {
    const written: [string, string][] = [];
    const { writeFileExecute, editFileExecute } = createFileExecutors({
      repoRoot: repo,
      onWrite: (filePath, content) => written.push([filePath, content]),
    });
    await writeFileExecute({ path: 'src/a.ts', content: 'export const a = 1;\nexport const b = 2;\n' });
    await editFileExecute({ path: 'src/a.ts', oldText: 'b = 2', newText: 'b = 3' });
    expect(written).toEqual([
      ['src/a.ts', 'export const a = 1;\nexport const b = 2;\n'],
      ['src/a.ts', 'export const a = 1;\nexport const b = 3;\n'],
    ]);
  });

  test('is not told of an edit that failed', async () => {
    writeFileSync(path.join(repo, 'b.ts'), 'x\n');
    const written: string[] = [];
    const { editFileExecute } = createFileExecutors({ repoRoot: repo, onWrite: (p) => written.push(p) });
    await expect(editFileExecute({ path: 'b.ts', oldText: 'missing', newText: 'y' })).rejects.toThrow('oldText not found');
    expect(written).toEqual([]);
  });
});

// edit_file's reply carries the lines around the change, and a missed
// oldText comes back with the file's current text where it was closest, so
// the next edit needn't start with a read.
describe('edit_file replies', () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), 'file-tools-'));
    writeFileSync(path.join(repo, 'a.ts'), ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'].join('\n'));
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  test('a successful edit shows the lines either side of the new text', async () => {
    const { editFileExecute } = createFileExecutors({ repoRoot: repo });
    const reply = await editFileExecute({ path: 'a.ts', oldText: 'five', newText: 'FIVE\nFIVE-B' });
    expect(reply).toStartWith('Edited a.ts (lines 5-6 of 9)');
    expect(reply).toContain('two\nthree\nfour\n… your new text, lines 5-6 …\nsix\nseven\neight');
  });

  test('a missed oldText shows where its first line still is', async () => {
    const { editFileExecute } = createFileExecutors({ repoRoot: repo });
    await expect(editFileExecute({ path: 'a.ts', oldText: 'four\nFIVE', newText: 'x' })).rejects.toThrow(
      'Current text at lines 2-7:\n```\ntwo\nthree\nfour\nfive\nsix\nseven\n```'
    );
  });

  test('nothing extra when no line of oldText is in the file', async () => {
    const { editFileExecute } = createFileExecutors({ repoRoot: repo });
    await expect(editFileExecute({ path: 'a.ts', oldText: 'absent text', newText: 'x' })).rejects.toThrow(/Nothing was changed\.$/);
  });
});
