import { tool } from 'ai';
import { z } from 'zod';
import { getSession, mutateSession } from '../../sessions/session-store.js';
import type { QaReviewFindings, QaTeamMember } from '../../sessions/session.js';
import { reviewAreaSchema, validateReviewAreas } from '../team/qa-review-areas.js';

// ---------------------------------------------------------------- assign_qa_team (the QA lead)

export const assignQaTeamSchema = z.object({
  reviewers: z
    .array(reviewAreaSchema)
    .min(2)
    .describe('2+ reviewers, each checking its own acceptance criteria in parallel with the others. Together they cover every criterion.'),
});

export const assignQaTeamDescription =
  'Split this QA review across a team of reviewers who check the branch in parallel, instead of reviewing every ' +
  'acceptance criterion yourself. You are the QA lead: this is your call to make at the start of a review.\n\n' +
  'Split only when it genuinely saves time: the requirements have several acceptance criteria that fall into two or ' +
  'more groups touching different parts of the diff (e.g. an API and the page that calls it, two unrelated ' +
  'adapters), and each group is a meaningful amount of reading. A small diff or a handful of criteria you review ' +
  'yourself — don\'t call this.\n\n' +
  'For each reviewer: the acceptance criteria it verifies (worded as in the requirements doc; every criterion goes ' +
  'to exactly one reviewer, and "Docs to update" counts as a criterion), the diff paths to focus on, and a brief. ' +
  'Reviewers are read-only and can\'t run checks or write the report: lint and the unit tests run alongside them, ' +
  'so don\'t run those yourself first.\n\n' +
  'Look before you split: get_diff (no path) and the requirements doc tell you which criteria touch which files. ' +
  'Once it succeeds, end your turn with a few lines to the human on who checks what. The team starts when your ' +
  'turn ends; when it finishes you get every reviewer\'s findings and the check results, re-check anything that ' +
  'looks doubtful, and write the one QA report.';

/**
 * Records the QA lead's split as the session's next QA team round
 * ("assigned"). The QA tab starts it (agents/team/qa-team.ts) once the
 * lead's turn has ended.
 */
export function createAssignQaTeamExecute(deps: { sessionId: string }) {
  return async ({ reviewers }: z.infer<typeof assignQaTeamSchema>): Promise<string> => {
    const session = await getSession(deps.sessionId);
    if (!session) throw new Error('Session not found.');
    if (session.qaTeam?.status === 'running') throw new Error('A QA team is already running for this session.');
    // Thrown before anything is saved, so the model sees why and retries.
    const valid = validateReviewAreas(reviewers);

    let round = 1;
    await mutateSession(deps.sessionId, (s) => {
      const previous = s.qaTeam;
      // Re-assigning before the team started replaces that split.
      if (previous && previous.status !== 'assigned') s.qaTeamHistory.push(previous);
      round = previous
        ? previous.status === 'assigned'
          ? previous.round
          : previous.round + 1
        : (s.qaTeamHistory[s.qaTeamHistory.length - 1]?.round ?? 0) + 1;
      s.qaTeam = {
        status: 'assigned',
        round,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        relayed: false,
        checks: [
          { command: 'lint', status: 'pending', output: null },
          { command: 'test', status: 'pending', output: null },
        ],
        members: valid.map(
          (area): QaTeamMember => ({
            ...area,
            status: 'waiting',
            note: null,
            startedAt: null,
            finishedAt: null,
            transcript: [],
            history: [],
            claudeSessionId: null,
            findings: null,
          }),
        ),
      };
    });

    return (
      `QA team assigned (round ${round}): ${valid.map((r) => `${r.id} → ${r.criteria.length} criteria`).join('; ')}. ` +
      'Lint and the unit tests run alongside them. End your turn now with a short note to the human on who checks ' +
      'what — the team starts when your turn ends.'
    );
  };
}

export function createAssignQaTeamTool(deps: { sessionId: string }) {
  return tool({ description: assignQaTeamDescription, inputSchema: assignQaTeamSchema, execute: createAssignQaTeamExecute(deps) });
}

// ---------------------------------------------------------------- submit_review (a reviewer)

export const submitReviewSchema = z.object({
  summary: z.string().describe('At most 3 sentences: what you checked and the overall state of your area.'),
  criteria: z
    .array(
      z.object({
        criterion: z.string().describe('The acceptance criterion, as you were given it'),
        verdict: z.enum(['met', 'not-met', 'unverified']),
        note: z.string().describe('One line: where it is implemented (file), or why it is not met / could not be verified'),
      }),
    )
    .describe('One entry per acceptance criterion you were given, none left out.'),
  blockingFindings: z
    .array(z.string())
    .describe('One line per thing the coding agent must fix: file (and line if known), what is wrong, what to do. Empty if none.'),
  actionableNotes: z
    .array(z.string())
    .describe('One line per non-blocking thing still worth fixing (missed edge case, weak test, leftover debug code). Same format. Empty if none.'),
});

export const submitReviewDescription =
  'Hand your findings to the QA lead. Call it exactly once, when you have checked every criterion you were given, ' +
  'then end your turn with no further text. Calling it again replaces what you submitted.';

export function createSubmitReviewExecute(deps: { sessionId: string; memberId: string }) {
  return async (input: z.infer<typeof submitReviewSchema>): Promise<string> => {
    const findings: QaReviewFindings = {
      summary: input.summary.trim(),
      criteria: input.criteria,
      blockingFindings: input.blockingFindings.map((f) => f.trim()).filter(Boolean),
      actionableNotes: input.actionableNotes.map((n) => n.trim()).filter(Boolean),
    };
    await mutateSession(deps.sessionId, (s) => {
      const m = s.qaTeam?.members.find((x) => x.id === deps.memberId);
      if (m) m.findings = findings;
    });
    const notMet = findings.criteria.filter((c) => c.verdict !== 'met').length;
    return `Submitted: ${findings.criteria.length} criteria (${notMet} not met or unverified), ${findings.blockingFindings.length} blocking, ${findings.actionableNotes.length} notes. End your turn now.`;
  };
}

export function createSubmitReviewTool(deps: { sessionId: string; memberId: string }) {
  return tool({ description: submitReviewDescription, inputSchema: submitReviewSchema, execute: createSubmitReviewExecute(deps) });
}
