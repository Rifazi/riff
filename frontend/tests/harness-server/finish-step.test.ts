import { describe, expect, test } from 'bun:test';

import { checkPassed, checksFailedReply } from '../../../harness-server/backend/src/agents/tool-defs/finish-step-tool';

// finish_step reads run_checked_command's report: its first line says whether the script passed.
describe('finish_step', () => {
  test('a check passed only when its first line says it succeeded', () => {
    expect(checkPassed('lint succeeded.')).toBe(true);
    expect(checkPassed('test succeeded.\n\n12 tests, 0 failures')).toBe(true);
    expect(checkPassed('lint failed.\n\nsrc/a.ts:3 error')).toBe(false);
    expect(checkPassed('test failed (TIMED OUT).')).toBe(false);
    expect(checkPassed('')).toBe(false);
  });

  test('failing checks keep the commit and leave the step open', () => {
    const reply = checksFailedReply('one', 'Committed ab12cd34: feat: add b', 'lint', 'lint failed.\n\nx');
    expect(reply.startsWith('Committed ab12cd34: feat: add b. Step "one" is still in progress: lint failed.')).toBe(true);
    expect(reply.endsWith('lint failed.\n\nx')).toBe(true);
  });
});
