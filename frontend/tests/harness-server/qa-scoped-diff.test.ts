import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createQaExecutors } from '../../../harness-server/backend/src/agents/tool-defs/qa-tools';

let repo: string;
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' }).toString();
const write = (file: string, text: string) => {
  mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  writeFileSync(path.join(repo, file), text);
};

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'qa-diff-'));
  git('init', '-q', '-b', 'master');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  write('src/api/a.ts', 'export const a = 1;\n');
  write('src/ui/b.ts', 'export const b = 1;\n');
  git('add', '.');
  git('commit', '-qm', 'init');
  git('checkout', '-qb', 'feature');
  write('src/api/a.ts', 'export const a = 2;\n');
  write('src/ui/b.ts', 'export const b = 2;\n');
  git('commit', '-qam', 'change');
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

// The lead and every reviewer used to pull the whole diff; a reviewer only needs its own area's.
describe('get_diff for a QA reviewer', () => {
  test('without focus paths returns every file', async () => {
    const { getDiffExecute } = createQaExecutors({ repoRoot: repo, baseBranch: 'master' });
    const out = await getDiffExecute({ branchName: 'feature' });
    expect(out).toContain('### src/api/a.ts');
    expect(out).toContain('### src/ui/b.ts');
  });

  test('with focus paths keeps the whole stat but only those diffs', async () => {
    const { getDiffExecute } = createQaExecutors({ repoRoot: repo, baseBranch: 'master', focusPaths: ['src/api'] });
    const out = await getDiffExecute({ branchName: 'feature' });
    expect(out).toMatch(/src\/ui\/b\.ts +\|/);
    expect(out).toContain('### src/api/a.ts');
    expect(out).not.toContain('### src/ui/b.ts');
    expect(out).toContain('only your focus paths');
  });

  test('a path outside the focus is still fetched in full', async () => {
    const { getDiffExecute } = createQaExecutors({ repoRoot: repo, baseBranch: 'master', focusPaths: ['src/api'] });
    expect(await getDiffExecute({ branchName: 'feature', path: 'src/ui/b.ts' })).toContain('export const b = 2;');
  });

  test('an unchanged repeat gets a note once, then the text again', async () => {
    const { getDiffExecute } = createQaExecutors({ repoRoot: repo, baseBranch: 'master' });
    const first = await getDiffExecute({ branchName: 'feature' });
    expect(await getDiffExecute({ branchName: 'feature' })).toContain('unchanged since you last fetched it');
    expect(await getDiffExecute({ branchName: 'feature' })).toBe(first);
  });
});
