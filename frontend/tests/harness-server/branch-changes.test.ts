import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { branchChanges } from '../../../harness-server/backend/src/repo/git';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();

describe('branchChanges', () => {
  test('a folder the branch deleted or renamed away is not a changed file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-changes-'));
    try {
      git(dir, 'init', '-b', 'main');
      git(dir, 'config', 'user.email', 't@t');
      git(dir, 'config', 'user.name', 't');
      for (const f of ['server/src/projects/a.ts', 'server/src/keep/b.ts']) {
        fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
        fs.writeFileSync(path.join(dir, f), 'export const x = 1;\n');
      }
      git(dir, 'add', '-A');
      git(dir, 'commit', '-m', 'base');
      git(dir, 'checkout', '-b', 'feature');
      git(dir, 'rm', '-r', 'server/src/projects');
      fs.mkdirSync(path.join(dir, 'server/src/new-name'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'server/src/new-name/a.ts'), 'export const x = 2;\n');
      git(dir, 'add', '-A');
      git(dir, 'commit', '-m', 'rename');

      const changes = await branchChanges(dir, 'main', ':(glob)**/DOMAIN.md', 'feature');
      expect(changes?.files).toEqual(['server/src/new-name/a.ts']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
