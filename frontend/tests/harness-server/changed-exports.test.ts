import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  changedExports,
  changedRanges,
  exportsTouched,
  formatExports,
  MAX_EXPORT_LINES,
} from '../../../harness-server/backend/src/agents/team/changed-exports';

describe('changedRanges', () => {
  test('reads the new-side ranges of each file, pure deletions included', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -3,0 +4,2 @@ x',
      '@@ -10 +12 @@ y',
      '@@ -20,3 +22,0 @@ z',
      'diff --git a/src/gone.ts b/src/gone.ts',
      '--- a/src/gone.ts',
      '+++ /dev/null',
      '@@ -1,5 +0,0 @@',
    ].join('\n');
    expect([...changedRanges(diff)]).toEqual([['src/a.ts', [[4, 5], [12, 12], [22, 22]]]]);
  });
});

describe('exportsTouched', () => {
  const outline = [
    '1-2  imports: ./x',
    '4-9  export function a(n: number): string',
    '11  const hidden = 1',
    '13-20  export class B',
    '  14-16  run(): void',
  ];

  test('keeps top-level exports that overlap a change', () => {
    expect(exportsTouched(outline, [[15, 15]])).toEqual([{ line: 13, text: 'export class B' }]);
    expect(exportsTouched(outline, [[9, 11]])).toEqual([{ line: 4, text: 'export function a(n: number): string' }]);
  });

  test('ignores unexported and untouched declarations', () => {
    expect(exportsTouched(outline, [[11, 11]])).toEqual([]);
    expect(exportsTouched(outline, [[30, 31]])).toEqual([]);
  });
});

test('formatExports caps the list and counts the rest', () => {
  const entries = Array.from({ length: MAX_EXPORT_LINES + 3 }, (_, i) => ({ line: i + 1, text: `export const c${i} = 1` }));
  const lines = formatExports([{ path: 'a.ts', entries }]);
  expect(lines).toHaveLength(MAX_EXPORT_LINES + 1);
  expect(lines[0]).toBe('a.ts:1  export const c0 = 1');
  expect(lines.at(-1)).toBe('… and 3 more');
});

describe('changedExports on a branch', () => {
  let repo: string;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), 'changed-exports-'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 'Test');
    mkdirSync(path.join(repo, 'src'));
    writeFileSync(path.join(repo, 'src/store.ts'), 'export function get(id: string): string {\n  return id;\n}\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    git('checkout', '-q', '-b', 'feat--api');
    writeFileSync(
      path.join(repo, 'src/store.ts'),
      'export function get(id: string): string {\n  return id;\n}\n\nexport function put(id: string, value: number): void {\n  void id;\n  void value;\n}\n',
    );
    writeFileSync(path.join(repo, 'src/store.test.ts'), 'export const fixture = 1;\n');
    git('add', '.');
    git('commit', '-q', '-m', 'feat: put');
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  test('lists the exports the branch adds, not unchanged ones or test files', async () => {
    expect(await changedExports(repo, 'feat--api', 'main')).toEqual([
      'src/store.ts:5  export function put(id: string, value: number): void',
    ]);
  });
});
