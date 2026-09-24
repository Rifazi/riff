import { tool } from 'ai';
import { z } from 'zod';
import { updateSession } from '../../sessions/session-store.js';

export const codingPlanStepSchema = z.object({
  id: z.string().describe('Short stable slug, e.g. "schema", "primary-adapter", "cdk-stateful" — keep the same id across calls for the same step'),
  title: z.string().describe('Short human-readable title, e.g. "Add the acme-inventory JSON schema"'),
  status: z.enum(['pending', 'in_progress', 'done']),
});

export const writeCodingPlanSchema = z.object({
  steps: z.array(codingPlanStepSchema).min(1),
});

export const writeCodingPlanDescription =
  "Declare or update the checklist of discrete implementation steps for this feature, so the human reviews " +
  "and approves the diff step by step instead of only seeing one giant diff at the end. Call this once near " +
  "the start of the coding stage, right after git_create_branch and before any file writes, with the full " +
  "list of steps — one per affected layer from the requirements doc (schema, primary adapter, secondary " +
  "adapter, CDK stateful, CDK stateless, OpenAPI/docs), not one per file, each sized so it's completable in " +
  "roughly a dozen tool calls (split a layer into more than one step if it needs more than that) — all " +
  "'pending' except the first, which is 'in_progress'. Call it again every time a step's status changes (mark " +
  "the current step 'done' and the next one 'in_progress', or split the remainder of an in-progress step into " +
  "a new pending one if it's turning out larger than expected) — always pass the complete list, not a diff.";

export function createWriteCodingPlanExecute(sessionId: string) {
  return async ({ steps }: z.infer<typeof writeCodingPlanSchema>): Promise<string> => {
    await updateSession(sessionId, { codingPlan: steps });
    return `Plan saved: ${steps.map((s) => `${s.title} [${s.status}]`).join(', ')}`;
  };
}

export function createWriteCodingPlanTool(sessionId: string) {
  return tool({
    description: writeCodingPlanDescription,
    inputSchema: writeCodingPlanSchema,
    execute: createWriteCodingPlanExecute(sessionId),
  });
}
