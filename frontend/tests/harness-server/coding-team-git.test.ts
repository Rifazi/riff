import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { validateWorkstreams } from '../../../harness-server/backend/src/agents/team/workstreams';
import {
  committedPathsOutside,
  discardPaths,
  mergeBranch,
  stageAndCommit,
  uncommittedPathsOutside,
  withinPaths,
} from '../../../harness-server/backend/src/repo/git';

const ws = (id: string, stepIds: string[], ownedPaths: string[], dependsOn: string[] = []) => ({
  id,
  title: id,
  stepIds,
  ownedPaths,
  dependsOn,
});

// A team only pays off when the longest chain is a small enough share of the work.
describe('validateWorkstreams: is a split worth it', () => {
  test('accepts two independent workstreams', () => {
    expect(() => validateWorkstreams(['a', 'b'], [ws('api', ['a'], ['src/api']), ws('ui', ['b'], ['src/ui'])])).not.toThrow();
  });

  test('accepts a small foundation with two leaves', () => {
    const split = [
      ws('base', ['a'], ['src/types.ts']),
      ws('api', ['b'], ['src/api'], ['base']),
      ws('ui', ['c'], ['src/ui'], ['base']),
    ];
    expect(() => validateWorkstreams(['a', 'b', 'c'], split)).not.toThrow();
  });

  test('rejects a big foundation with small leaves', () => {
    const split = [
      ws('base', ['a', 'b', 'c'], ['src/core']),
      ws('api', ['d'], ['src/api'], ['base']),
      ws('ui', ['e'], ['src/ui'], ['base']),
    ];
    expect(() => validateWorkstreams(['a', 'b', 'c', 'd', 'e'], split)).toThrow(/barely save/);
  });

  test('rejects one big workstream beside a tiny one, counting light steps as half', () => {
    const split = [ws('big', ['a', 'b', 'c', 'd'], ['src/big']), ws('tiny', ['e'], ['src/tiny'])];
    expect(() => validateWorkstreams(['a', 'b', 'c', 'd', 'e'], split)).toThrow(/barely save/);
    // Same shape, but the big side is mostly light work: 2.5 of 3.5.
    const efforts = new Map<string, 'light' | 'standard'>([
      ['b', 'light'],
      ['c', 'light'],
      ['d', 'light'],
    ]);
    const small = [ws('big', ['a', 'b', 'c'], ['src/big']), ws('tiny', ['e'], ['src/tiny'])];
    expect(() => validateWorkstreams(['a', 'b', 'c', 'e'], small, efforts)).not.toThrow();
  });

  test('still rejects overlapping paths', () => {
    expect(() => validateWorkstreams(['a', 'b'], [ws('x', ['a'], ['src']), ws('y', ['b'], ['src/ui'])])).toThrow(/overlap/);
  });
});

describe('withinPaths', () => {
  test('matches files and directories, not name prefixes', () => {
    expect(withinPaths('src/api/a.ts', ['src/api'])).toBe(true);
    expect(withinPaths('./src/api', ['src/api/'])).toBe(true);
    expect(withinPaths('src/apiary.ts', ['src/api'])).toBe(false);
  });
});

// A coding-team member's commits stay inside its owned paths.
describe('team git guards', () => {
  let repo: string;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  const write = (rel: string, text: string) => {
    mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    writeFileSync(path.join(repo, rel), text);
  };

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), 'team-git-'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 'Test');
    write('src/api/a.ts', 'a\n');
    write('src/ui/b.ts', 'b\n');
    write('package-lock.json', '{}\n');
    git('add', '-A');
    git('commit', '-qm', 'init');
    git('checkout', '-qb', 'feature');
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  test('git_commit refuses files outside the scope', async () => {
    write('src/ui/b.ts', 'changed\n');
    await expect(stageAndCommit(repo, 'feature', 'fix: x', ['src/ui/b.ts'], ['src/api'])).rejects.toThrow(/owned paths/);
  });

  test('a catch-all commit only stages the scope', async () => {
    write('src/api/a.ts', 'mine\n');
    write('src/ui/b.ts', 'not mine\n');
    await stageAndCommit(repo, 'feature', 'feat: api', [], ['src/api']);
    expect(git('show', '--name-only', '--format=', 'HEAD')).toBe('src/api/a.ts');
    expect(git('status', '--porcelain')).toBe('M src/ui/b.ts');
  });

  test('stray changes outside the scope are found and discarded', async () => {
    write('src/api/new.ts', 'mine\n');
    write('src/ui/b.ts', 'lint fix\n');
    write('package-lock.json', '{"x":1}\n');
    write('coverage/out.txt', 'junk\n');
    git('mv', 'src/ui/b.ts', 'src/ui/c.ts');
    const stray = await uncommittedPathsOutside(repo, ['src/api']);
    expect(stray.sort()).toEqual(['coverage/out.txt', 'package-lock.json', 'src/ui/b.ts', 'src/ui/c.ts']);
    await discardPaths(repo, stray);
    expect(await uncommittedPathsOutside(repo, ['src/api'])).toEqual([]);
    expect(readFileSync(path.join(repo, 'src/ui/b.ts'), 'utf8')).toBe('b\n');
    expect(existsSync(path.join(repo, 'src/ui/c.ts'))).toBe(false);
    expect(existsSync(path.join(repo, 'src/api/new.ts'))).toBe(true);
  });

  test('committed changes outside the scope are reported', async () => {
    git('checkout', '-qb', 'member');
    write('src/api/a.ts', 'x\n');
    write('src/ui/b.ts', 'y\n');
    git('commit', '-qam', 'both');
    expect(await committedPathsOutside(repo, 'feature', 'member', ['src/api'])).toEqual(['src/ui/b.ts']);
  });

  test('merge refuses when the checkout is on another branch or dirty', async () => {
    git('checkout', '-qb', 'member');
    write('src/api/a.ts', 'x\n');
    git('commit', '-qam', 'work');
    git('checkout', '-q', 'main');
    const wrong = await mergeBranch(repo, 'member', 'chore: merge', 'feature');
    expect(wrong.ok).toBe(false);
    expect(git('log', '-1', '--format=%s', 'main')).toBe('init');

    git('checkout', '-q', 'feature');
    write('src/ui/b.ts', 'dirty\n');
    expect((await mergeBranch(repo, 'member', 'chore: merge', 'feature')).ok).toBe(false);

    git('checkout', '--', 'src/ui/b.ts');
    expect((await mergeBranch(repo, 'member', 'chore: merge', 'feature')).ok).toBe(true);
    expect(git('log', '-1', '--format=%s', 'feature')).toBe('chore: merge');
  });
});
