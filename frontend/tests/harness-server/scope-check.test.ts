import { describe, expect, test } from 'bun:test';

import { outOfPlan } from '../../../harness-server/backend/src/agents/scope-check';

const plan = 'rename movies-ui and client/src/app-shell/App.tsx; server/src/movies';

describe('outOfPlan', () => {
  test('a new domain the plan never names is reported', () => {
    const found = outOfPlan(['client/src/app-shell/App.tsx', 'client/src/movie-workspace-ui/service.ts'], ['client/src/movie-workspace-ui/README.md'], plan);
    expect(found?.newDomains).toEqual(['client/src/movie-workspace-ui']);
  });

  test('work under a named folder, docs and tests are in scope', () => {
    expect(outOfPlan(['client/src/movies-ui/a/b.tsx', 'docs/x.md', 'client/src/other/a.test.ts'], [], plan)).toBeNull();
  });

  test('stray folders are reported only from three up', () => {
    expect(outOfPlan(['x/aaaa/a.ts', 'x/bbbb/b.ts'], [], plan)).toBeNull();
    expect(outOfPlan(['x/aaaa/a.ts', 'x/bbbb/b.ts', 'x/cccc/c.ts'], [], plan)?.folders.length).toBe(3);
  });
});
