import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { worktreeFingerprint } from '../../../harness-server/backend/src/repo/git';
import { alreadyPassed, checkPassed, checksFailedReply } from '../../../harness-server/backend/src/agents/tool-defs/finish-step-tool';
import { CheckCache } from '../../../harness-server/backend/src/agents/tool-defs/qa-tools';

// finish_step reads run_checked_command's report: its status line says whether the script passed.
describe('finish_step', () => {
  test('a check passed only when its status line says it succeeded', () => {
    expect(checkPassed('lint succeeded.')).toBe(true);
    expect(checkPassed('test succeeded.\n\n12 tests, 0 failures')).toBe(true);
    expect(checkPassed('lint failed.\n\nsrc/a.ts:3 error')).toBe(false);
    expect(checkPassed('test failed (TIMED OUT).')).toBe(false);
    expect(checkPassed('')).toBe(false);
  });

  test('a check that installed dependencies first still passes', () => {
    expect(checkPassed('Installed dependencies in client/.\n\nlint succeeded.')).toBe(true);
    expect(checkPassed(alreadyPassed('test'))).toBe(true);
  });

  test('failing checks keep the commit and leave the step open', () => {
    const reply = checksFailedReply('one', 'Committed ab12cd34: feat: add b', 'lint', 'lint failed.\n\nx');
    expect(reply.startsWith('Committed ab12cd34: feat: add b. Step "one" is still in progress: lint failed.')).toBe(true);
    expect(reply.endsWith('lint failed.\n\nx')).toBe(true);
    expect(reply).toContain('running the check again without changing anything returns the same failure');
  });
});

// finish_step skips a check that already passed on exactly this code.
describe('check cache', () => {
  test('remembers a pass per command and forgets it on a failure', () => {
    const cache = new CheckCache();
    cache.record('lint', 'tree-a', true);
    expect(cache.passedOn('lint', 'tree-a')).toBe(true);
    expect(cache.passedOn('lint', 'tree-b')).toBe(false);
    expect(cache.passedOn('test', 'tree-a')).toBe(false);
    cache.record('lint', 'tree-a', false);
    expect(cache.passedOn('lint', 'tree-a')).toBe(false);
  });
});

describe('worktreeFingerprint', () => {
  let repo: string;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), 'fingerprint-'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    writeFileSync(path.join(repo, 'a.ts'), 'a\n');
    git('add', '.');
    git('commit', '-qm', 'init');
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  test('same files, same hash, whether or not they are committed', async () => {
    writeFileSync(path.join(repo, 'b.ts'), 'b\n');
    const before = await worktreeFingerprint(repo);
    git('add', '.');
    git('commit', '-qm', 'b');
    expect(await worktreeFingerprint(repo)).toBe(before);
    expect(git('status', '--porcelain')).toBe('');
  });

  test('changes with the code, not with check output', async () => {
    const before = await worktreeFingerprint(repo);
    writeFileSync(path.join(repo, 'junit.xml'), '<testsuites/>');
    expect(await worktreeFingerprint(repo)).toBe(before);
    writeFileSync(path.join(repo, 'a.ts'), 'changed\n');
    expect(await worktreeFingerprint(repo)).not.toBe(before);
  });

  test("leaves the real index alone", async () => {
    writeFileSync(path.join(repo, 'c.ts'), 'c\n');
    await worktreeFingerprint(repo);
    expect(git('status', '--porcelain')).toBe('?? c.ts');
  });
});
