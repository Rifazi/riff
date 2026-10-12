import { describe, expect, test } from 'bun:test';

import {
  concernInLastMessage,
  hasPendingQuestionTool,
  latestChecksFailed,
} from '../../../harness-server/backend/src/agents/coordinator-agent';
import type { TranscriptEntry } from '../../../harness-server/backend/src/sessions/session';

let n = 0;
const e = (role: TranscriptEntry['role'], extra: Partial<TranscriptEntry> = {}): TranscriptEntry =>
  ({ id: String(n++), timestamp: '2026-10-10T00:00:00Z', role, ...extra }) as TranscriptEntry;
const result = (toolName: string, text: string) => e('tool_result', { toolName, toolResult: [{ type: 'text', text }] });

// What stops Bridget before she approves a finished coding stage, without a model.
describe('failing checks', () => {
  test('the latest run decides, a fix after a failure counts', () => {
    expect(latestChecksFailed([result('mcp__harness-tools__run_checked_command', 'test failed.\n\n2 failures')])).toBe(true);
    expect(
      latestChecksFailed([
        result('run_checked_command', 'test failed.'),
        result('run_checked_command', 'test succeeded.\n\n48 tests'),
      ]),
    ).toBe(false);
  });

  test('finish_step results count too', () => {
    expect(latestChecksFailed([result('finish_step', 'Committed ab12: feat: x. Step "a" is still in progress: lint failed.')])).toBe(true);
    expect(latestChecksFailed([result('finish_step', 'Committed ab12: feat: x. Formatted 2 file(s); lint and tests passed. Step "a" is done.')])).toBe(false);
  });

  test('no checks run is not a failure', () => {
    expect(latestChecksFailed([e('assistant', { text: 'Done.' })])).toBe(false);
  });
});

describe('worrying words in the closing message', () => {
  test('failures explained away still stop', () => {
    expect(concernInLastMessage([e('assistant', { text: 'Lint passes, but 2 tests fail; they look pre-existing.' })])).toBe('fail');
    expect(concernInLastMessage([e('assistant', { text: "I couldn't verify the deploy locally." })])).toBe("couldn't");
  });

  test('a clean summary passes', () => {
    expect(concernInLastMessage([e('assistant', { text: 'All 6 steps are done. Lint passes and all 48 unit tests pass.' })])).toBeNull();
  });
});

test('a question tool after the human last spoke is pending', () => {
  expect(hasPendingQuestionTool([e('user', { text: 'go' }), e('tool_call', { toolName: 'mcp__harness-tools__ask_multiple_choice' })])).toBe(true);
  expect(hasPendingQuestionTool([e('tool_call', { toolName: 'ask_question' }), e('user', { text: 'B' })])).toBe(false);
});
