import { describe, expect, test } from 'bun:test';

import { MIN_GROWTH_TO_COMPACT, shouldCompact } from '../../../harness-server/backend/src/agents/compaction';

// A conversation is cut for compaction once its context reaches the
// threshold, but only after it has grown well past where it started.
describe('shouldCompact', () => {
  const at = { atTokens: 55_000 };

  test('not below the threshold', () => {
    expect(shouldCompact(at, 54_999, 10_000)).toBe(false);
  });

  test('not when the conversation started near the threshold', () => {
    expect(shouldCompact(at, 60_000, 60_000 - MIN_GROWTH_TO_COMPACT + 1)).toBe(false);
  });

  test('at the threshold once it has grown enough', () => {
    expect(shouldCompact(at, 55_000, 29_000)).toBe(true);
  });

  test('never without compaction or with an infinite threshold (the research helper)', () => {
    expect(shouldCompact(undefined, 500_000, 0)).toBe(false);
    expect(shouldCompact({ atTokens: Infinity }, 500_000, 0)).toBe(false);
  });
});
