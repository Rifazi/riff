import { describe, expect, test } from 'bun:test';

import { ReadMemo } from '../../../harness-server/backend/src/agents/tool-defs/read-memo';

describe('ReadMemo', () => {
  test('notes an unchanged repeat once, then gives the text again', () => {
    const memo = new ReadMemo();
    expect(memo.isRepeat('a.ts', 'v1')).toBe(false);
    expect(memo.isRepeat('a.ts', 'v1')).toBe(true);
    expect(memo.isRepeat('a.ts', 'v1')).toBe(false);
  });

  test('a changed file is never a repeat', () => {
    const memo = new ReadMemo();
    memo.isRepeat('a.ts', 'v1');
    expect(memo.isRepeat('a.ts', 'v2')).toBe(false);
  });

  // Compaction starts a fresh conversation without the old copy, so a read
  // from before it must come back in full the first time.
  test('clear() forgets every earlier read', () => {
    const memo = new ReadMemo();
    memo.isRepeat('a.ts', 'v1');
    memo.clear();
    expect(memo.isRepeat('a.ts', 'v1')).toBe(false);
  });
});
