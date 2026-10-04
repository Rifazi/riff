import { tool } from 'ai';
import { z } from 'zod';
import { mutateSession } from '../../sessions/session-store.js';

export const codingPlanStepSchema = z.object({
  id: z.string().describe('Short stable slug, e.g. "schema", "primary-adapter", "cdk-stateful" — keep the same id across calls for the same step'),
  title: z.string().describe('Short human-readable title, e.g. "Add the acme-inventory JSON schema"'),
  status: z.enum(['pending', 'in_progress', 'done']),
});

export const writeCodingPlanSchema = z.object({
  steps: z.array(codingPlanStepSchema).min(1),
  replace: z
    .boolean()
    .optional()
    .describe('true: `steps` is the whole new checklist (first call, or reconciling after a requirements/plan change). Otherwise only the steps you pass change.'),
});

export const writeCodingPlanDescription =
  "Declare or update the checklist of implementation steps the human reviews the diff by. First call (right " +
  "after git_create_branch, before any file writes): the full list with replace: true, the first step " +
  "'in_progress' and the rest 'pending'. After that, pass only the steps that changed — e.g. the finished step " +
  "as 'done' and the next as 'in_progress' — and the others keep theirs. A new id is inserted after the step " +
  "listed before it in your call (use that to split the rest of a long step into a new pending one).";

type Step = z.infer<typeof codingPlanStepSchema> & { brief?: string };

// Merges `changes` into `current` by id (keeping a step's brief, which this
// tool doesn't take). A new id goes after the step that precedes it in
// `changes`, or at the end when it's first.
export function mergeCodingPlan(current: Step[], changes: Step[]): Step[] {
  const merged = [...current];
  changes.forEach((step, i) => {
    const existing = merged.findIndex((s) => s.id === step.id);
    if (existing >= 0) {
      merged[existing] = { ...merged[existing], ...step };
      return;
    }
    const after = i > 0 ? merged.findIndex((s) => s.id === changes[i - 1].id) : -1;
    if (after >= 0) merged.splice(after + 1, 0, step);
    else merged.push(step);
  });
  return merged;
}

export function createWriteCodingPlanExecute(sessionId: string) {
  return async ({ steps, replace }: z.infer<typeof writeCodingPlanSchema>): Promise<string> => {
    let saved: Step[] = steps;
    await mutateSession(sessionId, (session) => {
      saved = replace || !session.codingPlan?.length ? steps : mergeCodingPlan(session.codingPlan, steps);
      session.codingPlan = saved;
    });
    const count = (status: Step['status']) => saved.filter((s) => s.status === status).length;
    const current = saved.find((s) => s.status === 'in_progress');
    return (
      `Checklist saved: ${count('done')} done, ${count('in_progress')} in progress, ${count('pending')} pending of ${saved.length}` +
      (current ? `; current: ${current.title} (id: "${current.id}")` : '') +
      '.'
    );
  };
}

export function createWriteCodingPlanTool(sessionId: string) {
  return tool({
    description: writeCodingPlanDescription,
    inputSchema: writeCodingPlanSchema,
    execute: createWriteCodingPlanExecute(sessionId),
  });
}
