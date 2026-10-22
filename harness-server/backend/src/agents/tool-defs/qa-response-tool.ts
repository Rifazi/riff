import { tool } from 'ai';
import { z } from 'zod';
import { mutateSession } from '../../sessions/session-store.js';

export const respondToQaSchema = z.object({
  responses: z
    .array(
      z.object({
        blocker: z.number().int().min(1).describe("The blocking finding's number in QA's list (Blocking 1, 2, ...)"),
        status: z
          .enum(['fixed', 'disputed', 'blocked'])
          .describe(
            'fixed: you changed the code. disputed: the finding is wrong or already satisfied. blocked: you could not fix it.',
          ),
        explanation: z
          .string()
          .min(20)
          .describe(
            'fixed: what you changed and why that satisfies the criterion. disputed: why the finding does not hold, ' +
              'quoting the line or behaviour QA got wrong. blocked: what you tried and exactly why it did not work.',
          ),
        evidence: z
          .string()
          .min(10)
          .describe(
            'Something QA can check without your chat: file:line of the change, the test that fails without it, ' +
              'or the exact command and its output (error text, failing assertion, actual vs expected).',
          ),
      }),
    )
    .min(1),
});

export const respondToQaDescription =
  'Answer QA\'s blocking findings one by one before you finish a QA fix. Every blocker needs an answer: fixed ' +
  '(what changed, and the test or file:line that proves it), disputed (why QA is wrong, with the exact line or ' +
  'behaviour), or blocked (what you tried and the exact error). QA reads these and either accepts a dispute or ' +
  'replies to it, so vague answers ("already handled", "could not reproduce") just send the same blocker back. ' +
  'Calling it again for a blocker replaces your earlier answer.';

/** Stores the coder's answers against the latest failing QA pass; QA's re-review brief and the next send-back carry them. */
export function createRespondToQaExecute(deps: { sessionId: string }) {
  return async ({ responses }: z.infer<typeof respondToQaSchema>): Promise<string> => {
    let problem: string | null = null;
    let open: number[] = [];
    await mutateSession(deps.sessionId, (s) => {
      const round = s.qaRounds[s.qaRounds.length - 1];
      if (!round || round.blocking.length === 0) {
        problem = 'QA has no blocking findings on record to answer.';
        return;
      }
      const bad = responses.find((r) => r.blocker > round.blocking.length);
      if (bad) {
        problem = `QA's last pass has ${round.blocking.length} blocking finding${round.blocking.length === 1 ? '' : 's'}; there is no Blocking ${bad.blocker}.`;
        return;
      }
      const at = new Date().toISOString();
      const mine = new Set(responses.map((r) => r.blocker));
      s.qaResponses = [
        ...s.qaResponses.filter((r) => r.pass !== round.pass || !mine.has(r.blocker)),
        ...responses.map((r) => ({
          pass: round.pass,
          blocker: r.blocker,
          finding: round.blocking[r.blocker - 1],
          status: r.status,
          explanation: r.explanation.trim(),
          evidence: r.evidence.trim(),
          at,
        })),
      ];
      const answered = new Set(s.qaResponses.filter((r) => r.pass === round.pass).map((r) => r.blocker));
      open = round.blocking.map((_, i) => i + 1).filter((n) => !answered.has(n));
    });
    if (problem) throw new Error(problem);
    return open.length ? `Recorded. Still unanswered: Blocking ${open.join(', ')}.` : 'Recorded. Every blocker has an answer; QA will read them.';
  };
}

export function createRespondToQaTool(deps: { sessionId: string }) {
  return tool({ description: respondToQaDescription, inputSchema: respondToQaSchema, execute: createRespondToQaExecute(deps) });
}
