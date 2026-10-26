import { describe, expect, test } from 'bun:test';

import { fixSplitBrief, parseFixSplit } from '../../../harness-server/backend/src/sessions/fix-split-core';
import { hotBlockerFiles, type QaRoundRecord } from '../../../harness-server/backend/src/sessions/qa-loop';

const round = (pass: number, blocking: string[]) => ({ pass, result: 'fail', blocking, notes: [], criteria: [], head: null, failedChecks: [] }) as unknown as QaRoundRecord;

describe('hotBlockerFiles', () => {
  test('files named by blockers in two passes', () => {
    const rounds = [
      round(1, ['server/src/orders/service.ts:40 drops the status', 'docs/a.md not updated']),
      round(2, ['server/src/orders/service.ts:62 still drops it']),
    ];
    expect(hotBlockerFiles(rounds)).toEqual(['service.ts']);
  });

  test('a file blocked in one pass is not hot', () => {
    expect(hotBlockerFiles([round(1, ['a/x.ts:1 bad']), round(2, ['b/y.ts:2 bad'])])).toEqual([]);
  });
});

describe('parseFixSplit', () => {
  const files = ['service.ts'];
  test('keeps 2-5 usable steps', () => {
    const raw = '{"steps":[{"title":"Keep status","files":["service.ts"],"instruction":"Copy status; test it."},{"title":"Map ids","instruction":"Fix mapping; test it."}]}';
    const split = parseFixSplit(raw, 2, files);
    expect(split?.steps.length).toBe(2);
    expect(fixSplitBrief(split!)).toContain('1. Keep status (service.ts): Copy status; test it.');
  });

  test('one step or junk is not a split', () => {
    expect(parseFixSplit('{"steps":[{"title":"a","instruction":"b"}]}', 2, files)).toBeNull();
    expect(parseFixSplit('nope', 2, files)).toBeNull();
  });
});
