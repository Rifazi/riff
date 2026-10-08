import { describe, expect, test } from 'bun:test';

import { commitMessageProblem } from '../../../harness-server/backend/src/agents/tool-defs/git-tools';

// A rejected commit says exactly why, so the agent fixes it in one try.
describe('commitMessageProblem', () => {
  test('accepts conventional commits, with or without scope and body', () => {
    expect(commitMessageProblem('fix: correct audit region validation status code')).toBeNull();
    expect(commitMessageProblem('feat(api): add region check')).toBeNull();
    expect(commitMessageProblem('fix: short subject\n\nA longer body that explains the change in detail.')).toBeNull();
  });

  test('names the subject length when it is too long', () => {
    const problem = commitMessageProblem(
      'fix: return 400 for unknown audit region instead of 502, fix comparisons httpStatus guard',
    );
    expect(problem).toContain('84 chars, max 72');
  });

  test('names the allowed types when the prefix is wrong', () => {
    expect(commitMessageProblem('Fixed the audit route')).toContain('feat, fix');
    expect(commitMessageProblem('bugfix: audit route')).toContain('type: ');
  });

  test('rejects an empty subject', () => {
    expect(commitMessageProblem('fix:  ')).toContain('empty');
  });
});
