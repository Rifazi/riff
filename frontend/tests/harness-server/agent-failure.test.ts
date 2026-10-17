import { describe, expect, test } from 'bun:test';

import {
  isSelfHealableBlock,
  isUsageLimitError,
  usageLimitStopReason,
} from '../../../harness-server/backend/src/agents/agent-failure';

describe('isUsageLimitError', () => {
  test('spots an exhausted quota or rate limit', () => {
    expect(isUsageLimitError("You've hit your usage limit. Resets at 5pm.")).toBe(true);
    expect(isUsageLimitError('Your credit balance is too low to access the API')).toBe(true);
    expect(isUsageLimitError('429 Too Many Requests')).toBe(true);
    expect(isUsageLimitError('insufficient_quota')).toBe(true);
  });

  test('leaves ordinary failures alone', () => {
    expect(isUsageLimitError('Reached maximum number of turns (20)')).toBe(false);
    expect(isUsageLimitError('ENOENT: no such file or directory')).toBe(false);
    expect(isUsageLimitError(null)).toBe(false);
  });

  test('the stop reason says it will not retry', () => {
    expect(usageLimitStopReason('usage limit reached')).toContain("I've stopped");
  });
});

describe('isSelfHealableBlock', () => {
  test('a missing test file or setup is the agent to fix', () => {
    const reason =
      'The agent is blocked because it cannot locate the test file EdiViewerPage.test.tsx and has no matches for React testing utilities, indicating a missing test setup.';
    expect(isSelfHealableBlock(reason, '')).toBe(true);
    expect(isSelfHealableBlock('blocked', "I couldn't find the config file.")).toBe(true);
  });

  test('credentials and decisions still stop', () => {
    expect(isSelfHealableBlock('Needs an API key; could not find one in the environment.', '')).toBe(false);
    expect(isSelfHealableBlock('The agent could not decide which option to take.', '')).toBe(false);
  });
});
