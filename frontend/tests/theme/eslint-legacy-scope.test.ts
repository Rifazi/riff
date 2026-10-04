import { readFileSync } from 'fs';
import { join } from 'path';

import { describe, expect, test } from 'bun:test';

// frontend/eslint.config.mjs relaxes three rules for the legacy files that still
// violate them. The relaxation has to stay pinned to explicit paths: a broad glob
// (or a rule turned off with no `files` at all) would silence new violations in the
// files this feature migrated, which is exactly the regression this test guards.
//
// Lives under tests/theme/ because that is the frontend's only lint/config test
// folder today; it is not theme-specific.
const CONFIG_PATH = join(import.meta.dir, '..', '..', 'eslint.config.mjs');

describe('eslint legacy relaxations stay narrowly scoped', () => {
  const source = readFileSync(CONFIG_PATH, 'utf8');

  test('no wildcard globs in the legacy file lists', () => {
    const globbed = [...source.matchAll(/'(src\/[^']*\*[^']*)'/g)].map((match) => match[1]);

    expect(globbed).toEqual([]);
  });

  test('every rule override is attached to a files list', () => {
    const configStart = source.indexOf('const eslintConfig = [');
    expect(configStart).toBeGreaterThan(-1);

    const blocks = source
      .slice(configStart)
      .split(/\n {2}\{/)
      .slice(1);
    const unscoped = blocks.filter((block) => block.includes("'off'") && !block.includes('files:'));

    expect(unscoped).toEqual([]);
  });
});
