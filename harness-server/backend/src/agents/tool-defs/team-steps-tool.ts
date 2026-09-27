import { tool } from 'ai';
import { z } from 'zod';
import { mutateSession } from '../../sessions/session-store.js';

export const updateMyStepsSchema = z.object({
  steps: z
    .array(z.object({ id: z.string(), status: z.enum(['pending', 'in_progress', 'done']) }))
    .min(1)
    .describe('Only your own workstream\'s step ids, with their new status'),
});

export const updateMyStepsDescription =
  "Update the status of YOUR workstream's steps on the coding team's shared checklist, which the human watches " +
  "live. Mark a step 'in_progress' when you start it and 'done' once it's committed and lint/tests pass. You can " +
  "only change your own steps — other members update theirs.";

/**
 * The team-member replacement for write_coding_plan: that tool overwrites
 * the whole checklist, which several concurrent members would clobber. This
 * one changes only this member's own steps, atomically under the session
 * lock.
 */
export function createUpdateMyStepsExecute(deps: { sessionId: string; stepIds: string[] }) {
  return async ({ steps }: z.infer<typeof updateMyStepsSchema>): Promise<string> => {
    const foreign = steps.filter((s) => !deps.stepIds.includes(s.id)).map((s) => s.id);
    if (foreign.length) {
      throw new Error(`Not your steps: ${foreign.join(', ')}. Your steps are: ${deps.stepIds.join(', ')}.`);
    }
    await mutateSession(deps.sessionId, (session) => {
      for (const update of steps) {
        const step = session.codingPlan?.find((s) => s.id === update.id);
        if (step) step.status = update.status;
      }
    });
    return `Updated: ${steps.map((s) => `${s.id} → ${s.status}`).join(', ')}`;
  };
}

export function createUpdateMyStepsTool(deps: { sessionId: string; stepIds: string[] }) {
  return tool({ description: updateMyStepsDescription, inputSchema: updateMyStepsSchema, execute: createUpdateMyStepsExecute(deps) });
}
