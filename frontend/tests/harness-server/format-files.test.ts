import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { formatFiles, formatRunReport } from '../../../harness-server/backend/src/agents/helpers/format/format';
import { createGitExecutors } from '../../../harness-server/backend/src/agents/tool-defs/git-tools';

// A repo with a stub prettier on npx's path: it appends "// formatted" to
// each file it's given, and fails on any file containing "SYNTAX ERROR".
let repo: string;
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'format-files-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  mkdirSync(path.join(repo, 'node_modules/.bin'), { recursive: true });
  const stub = path.join(repo, 'node_modules/.bin/prettier');
  writeFileSync(
    stub,
    '#!/bin/sh\n[ "$1" = "--write" ] || exit 9\nshift 2\nfor f in "$@"; do\n' +
      '  if grep -q "SYNTAX ERROR" "$f"; then echo "[error] $f: SyntaxError: Unexpected token (1:1)" >&2; exit 2; fi\n' +
      '  echo "// formatted" >> "$f"\ndone\n'
  );
  chmodSync(stub, 0o755);
  writeFileSync(path.join(repo, '.gitignore'), 'node_modules\n');
  git('add', '.');
  git('commit', '-qm', 'init');
  git('checkout', '-qb', 'feat');
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('formatFiles', () => {
  test('formats the files that exist and skips deleted ones', async () => {
    writeFileSync(path.join(repo, 'a.ts'), 'const a = 1;\n');
    const result = await formatFiles(repo, [path.join(repo, 'a.ts'), path.join(repo, 'gone.ts')]);
    expect(result).toEqual({ ok: true, formatted: 1 });
    expect(readFileSync(path.join(repo, 'a.ts'), 'utf8')).toBe('const a = 1;\n// formatted\n');
  });

  test('runs nothing when no file exists', async () => {
    expect(await formatFiles(repo, [path.join(repo, 'gone.ts')])).toEqual({ ok: true, formatted: 0 });
  });

  test('reports prettier failing', async () => {
    writeFileSync(path.join(repo, 'bad.ts'), 'SYNTAX ERROR\n');
    const result = await formatFiles(repo, [path.join(repo, 'bad.ts')]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.output).toContain('SyntaxError');
  });
});

// Each run is reported as helper `format`: counted, never given a token estimate.
describe('formatRunReport', () => {
  test('counts the files given and formatted', () => {
    const { stats, summary } = formatRunReport(2, { ok: true, formatted: 2 });
    expect(stats).toEqual({ helper: 'format', model: 'prettier', tasks: 2, useful: 2, savedTokens: null });
    expect(summary).toBe('Formatter: prettier formatted 2 files');
  });

  test('a failed run formatted nothing', () => {
    const { stats, summary } = formatRunReport(1, { ok: false, output: 'SyntaxError' });
    expect(stats.useful).toBe(0);
    expect(stats.savedTokens).toBeNull();
    expect(summary).toBe('Formatter: prettier failed on 1 file, nothing was committed');
  });
});

// git_commit formats what it commits, so agents need no separate prettier call.
describe('git_commit formats before committing', () => {
  const commit = (files: string[]) =>
    createGitExecutors({ repoRoot: repo, onBranchCreated: async () => {} }).gitCommitExecute({
      branchName: 'feat',
      message: 'feat: add a',
      files,
    });

  test('commits the formatted file', async () => {
    writeFileSync(path.join(repo, 'a.ts'), 'const a = 1;\n');
    expect(await commit(['a.ts'])).toMatch(/^Committed [0-9a-f]{8}: feat: add a$/);
    expect(git('show', 'HEAD:a.ts')).toBe('const a = 1;\n// formatted');
  });

  test('commits nothing when prettier fails', async () => {
    writeFileSync(path.join(repo, 'bad.ts'), 'SYNTAX ERROR\n');
    const reply = await commit(['bad.ts']);
    expect(reply.startsWith('Nothing committed: prettier failed')).toBe(true);
    expect(git('log', '--oneline').split('\n').length).toBe(1);
  });

  test('an invalid message is refused before anything is formatted', async () => {
    writeFileSync(path.join(repo, 'a.ts'), 'const a = 1;\n');
    await expect(
      createGitExecutors({ repoRoot: repo, onBranchCreated: async () => {} }).gitCommitExecute({
        branchName: 'feat',
        message: 'add a',
        files: ['a.ts'],
      })
    ).rejects.toThrow(/Not committed/);
    expect(readFileSync(path.join(repo, 'a.ts'), 'utf8')).toBe('const a = 1;\n');
  });
});
