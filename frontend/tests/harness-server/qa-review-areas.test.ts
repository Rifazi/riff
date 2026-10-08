import { describe, expect, test } from 'bun:test';

import {
  InvalidReviewAreasError,
  formatQaTeamFindings,
  validateReviewAreas,
} from '../../../harness-server/backend/src/agents/team/qa-review-areas';
import type { QaTeamMember, QaTeamState } from '../../../harness-server/backend/src/sessions/session';

const area = (id: string, criteria: string[], focusPaths: string[] = []) => ({ id, title: `${id} area`, criteria, focusPaths, brief: '' });

describe('validateReviewAreas', () => {
  test('accepts two reviewers with distinct criteria and normalizes paths', () => {
    const valid = validateReviewAreas([area('api', ['Totals round to 2dp'], ['./src/api/']), area('ui', ['Page shows totals'])]);
    expect(valid.map((a) => a.id)).toEqual(['api', 'ui']);
    expect(valid[0].focusPaths).toEqual(['src/api']);
  });

  test('a single reviewer is not a team', () => {
    expect(() => validateReviewAreas([area('api', ['a'])])).toThrow(InvalidReviewAreasError);
  });

  test('duplicate or non-slug ids are rejected', () => {
    expect(() => validateReviewAreas([area('api', ['a']), area('api', ['b'])])).toThrow(/Duplicate/);
    expect(() => validateReviewAreas([area('API Review', ['a']), area('ui', ['b'])])).toThrow(/slug/);
  });

  test('a criterion given to two reviewers is rejected, ignoring case and spacing', () => {
    expect(() => validateReviewAreas([area('api', ['Totals  round']), area('ui', ['totals round'])])).toThrow(/both/);
  });

  test('a reviewer with only blank criteria is rejected', () => {
    expect(() => validateReviewAreas([area('api', ['  ']), area('ui', ['b'])])).toThrow(/no acceptance criteria/);
  });

  test('paths outside the repo are rejected', () => {
    expect(() => validateReviewAreas([area('api', ['a'], ['../other']), area('ui', ['b'])])).toThrow(/focus path/);
  });
});

const member = (over: Partial<QaTeamMember>): QaTeamMember => ({
  ...area('api', ['Totals round to 2dp']),
  status: 'done',
  note: null,
  startedAt: null,
  finishedAt: null,
  transcript: [],
  history: [],
  claudeSessionId: null,
  findings: null,
  ...over,
});

describe('formatQaTeamFindings', () => {
  const team = (members: QaTeamMember[]): QaTeamState => ({
    status: 'needs_attention',
    round: 2,
    members,
    checks: [
      { command: 'lint', status: 'pass', output: 'lint succeeded.' },
      { command: 'test', status: 'fail', output: 'test:ci failed.\n\n1 tests, 1 failures' },
    ],
    startedAt: '',
    finishedAt: '',
    relayed: false,
  });

  test('lists checks, verdicts and findings, with failing output only', () => {
    const text = formatQaTeamFindings(
      team([
        member({
          findings: {
            summary: 'API is fine apart from rounding.',
            criteria: [{ criterion: 'Totals round to 2dp', verdict: 'not-met', note: 'src/api/totals.ts rounds to 0dp' }],
            blockingFindings: ['src/api/totals.ts:12 — use toFixed(2)'],
            actionableNotes: [],
          },
        }),
      ]),
    );
    expect(text).toContain('round 2');
    expect(text).toContain('- lint: pass');
    expect(text).not.toContain('lint succeeded.');
    expect(text).toContain('1 tests, 1 failures');
    expect(text).toContain('[not-met] Totals round to 2dp');
    expect(text).toContain('use toFixed(2)');
    expect(text).toContain('write_qa_report');
  });

  test("a reviewer without findings hands its criteria back to the lead", () => {
    const text = formatQaTeamFindings(team([member({ status: 'failed', note: 'Ran out of steps' })]));
    expect(text).toContain('no findings submitted — Ran out of steps');
    expect(text).toContain('review them yourself:\n- Totals round to 2dp');
  });
});
