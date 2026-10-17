import { describe, expect, test } from 'bun:test';

import {
  compactionDeferral,
  DEFER_CEILING_TOKENS,
  MIN_GROWTH_TO_COMPACT,
  shouldCompact,
  shouldCompactAfterBatch,
} from '../../../harness-server/backend/src/agents/compaction';

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

// A conversation that hasn't moved the work forward, or a lead between
// review_workstream and his verdict, isn't cut until the ceiling.
describe('deferred compaction', () => {
  const call = (toolName: string) => ({ role: 'tool_call', toolName });

  test('defer holds the cut below the ceiling only', () => {
    const deferred = { atTokens: 55_000, defer: () => true };
    expect(shouldCompact(deferred, 60_000, 29_000)).toBe(false);
    expect(shouldCompact(deferred, DEFER_CEILING_TOKENS, 29_000)).toBe(true);
    expect(shouldCompact({ atTokens: 55_000, defer: () => false }, 60_000, 29_000)).toBe(true);
  });

  test('no progress yet', () => {
    expect(compactionDeferral([call('read_file'), call('mcp__harness-tools__search_code')])).toBe('no progress yet');
    expect(compactionDeferral([call('read_file'), call('mcp__harness-tools__edit_file'), call('read_file')])).toBeNull();
  });

  test('a progress call that changed nothing is not progress', () => {
    const finish = (id: string) => ({ role: 'tool_call', toolName: 'mcp__harness-tools__finish_step', toolCallId: id });
    const result = (id: string, text: string, isError = false) => ({
      role: 'tool_result',
      toolCallId: id,
      toolResult: [{ type: 'text', text }],
      isError,
    });
    const refused = 'Nothing new to commit. Step "a" is still in progress: test failed.';
    expect(compactionDeferral([call('read_file'), finish('1'), result('1', refused)])).toBe('no progress yet');
    expect(compactionDeferral([finish('1'), result('1', 'Nothing done: the commit message is invalid', true)])).toBe(
      'no progress yet',
    );
    expect(compactionDeferral([finish('1'), result('1', 'Committed abc123. Step "a" is still in progress: test failed.')])).toBeNull();
    expect(compactionDeferral([finish('1'), result('1', refused), finish('2'), result('2', 'Committed abc. Step "a" is done.')])).toBeNull();
    expect(compactionDeferral([{ role: 'tool_call', toolName: 'edit_file', toolCallId: '3' }, result('3', 'Edited a.ts')])).toBeNull();
  });

  test('mid-review until the lead merges, sends back or drops', () => {
    expect(compactionDeferral([call('git_commit'), call('review_workstream'), call('read_file')])).toBe('mid-review');
    expect(compactionDeferral([call('review_workstream'), call('merge_workstream'), call('read_file')])).toBeNull();
    expect(compactionDeferral([call('review_workstream'), call('send_back_workstream'), call('review_workstream')])).toBe('mid-review');
  });
});

// The cut is decided at the end of a tool batch, before the next request.
describe('shouldCompactAfterBatch', () => {
  const at = { atTokens: 55_000 };
  const batch = { contextTokens: 50_000, outputTokens: 500, resultTokens: 0, startTokens: 20_000, progressed: false };

  test('counts what the batch will add to the context', () => {
    expect(shouldCompactAfterBatch(at, batch)).toBe(false);
    expect(shouldCompactAfterBatch(at, { ...batch, resultTokens: 4_600 })).toBe(true);
  });

  test('cuts a little early after a batch that made progress', () => {
    const near = { ...batch, contextTokens: 50_000 - 1_000 };
    expect(shouldCompactAfterBatch(at, near)).toBe(false);
    expect(shouldCompactAfterBatch(at, { ...near, progressed: true })).toBe(true);
    expect(shouldCompactAfterBatch(at, { ...batch, contextTokens: 40_000, progressed: true })).toBe(false);
  });

  test('still waits for growth and honours deferral', () => {
    expect(shouldCompactAfterBatch(at, { ...batch, startTokens: 45_000, progressed: true })).toBe(false);
    expect(shouldCompactAfterBatch({ ...at, defer: () => true }, { ...batch, resultTokens: 9_000 })).toBe(false);
  });

  test('never without compaction', () => {
    expect(shouldCompactAfterBatch(undefined, { ...batch, resultTokens: 99_000 })).toBe(false);
  });
});
