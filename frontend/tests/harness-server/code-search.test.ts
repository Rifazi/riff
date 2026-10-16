import { describe, expect, test } from 'bun:test';

import { clampContext, matchPaths } from '../../../harness-server/backend/src/agents/tool-defs/code-search-tool';

// search_code's fallback when no line matches: agents look files up by name
// with it, and a content-only miss sent them on several more searches.
describe('matchPaths', () => {
  const paths = ['backend/vitest.config.ts', 'backend/src/db/pool.ts', 'frontend/vite.config.ts', '.eslintrc.cjs'];

  test('matches as a case-insensitive regex, alternation included', () => {
    expect(matchPaths(paths, 'VITEST.config')).toEqual(['backend/vitest.config.ts']);
    expect(matchPaths(paths, 'vite(st)?\\.config')).toEqual(['backend/vitest.config.ts', 'frontend/vite.config.ts']);
    expect(matchPaths(paths, 'eslintrc|pool')).toEqual(['backend/src/db/pool.ts', '.eslintrc.cjs']);
  });

  test('falls back to a literal match for an invalid regex', () => {
    expect(matchPaths(['src/a(b.ts', 'src/c.ts'], 'a(b')).toEqual(['src/a(b.ts']);
  });

  test('caps the list', () => {
    expect(matchPaths(Array.from({ length: 40 }, (_, i) => `f${i}.ts`), 'f')).toHaveLength(15);
  });
});

// A `context` outside 0-3 is clamped: a rejected call cost a whole request.
describe('clampContext', () => {
  test('keeps 0-3, clamps the rest, leaves undefined alone', () => {
    expect(clampContext(undefined)).toBeUndefined();
    expect(clampContext(2)).toBe(2);
    expect(clampContext(15)).toBe(3);
    expect(clampContext(-1)).toBe(0);
    expect(clampContext(1.6)).toBe(2);
  });
});
