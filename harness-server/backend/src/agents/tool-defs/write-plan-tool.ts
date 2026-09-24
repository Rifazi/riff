import { promises as fs } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { tool } from 'ai';
import { z } from 'zod';
import { config } from '../../config.js';

export const planStepSchema = z.object({
  id: z.string().describe('Short stable slug, e.g. "schema", "primary-adapter", "cdk-stateful"'),
  title: z.string().describe('Short human-readable title, e.g. "Add the acme-inventory JSON schema"'),
});

export const writePlanSchema = z.object({
  markdownBody: z.string().describe('The plan doc body in markdown — rationale plus a description of each step'),
  steps: z
    .array(planStepSchema)
    .min(1)
    .describe('The same steps as in markdownBody, as a minimal structured list — this seeds the coding agent\'s checklist once approved'),
});
export const writePlanDescription =
  'Write (or overwrite) the plan document for this session. Pass the full markdown BODY (rationale, and for ' +
  'each step: what it does, which files/layers it touches) plus the same steps as a minimal structured list ' +
  '(id + title only — one per affected layer, not one per file, sized so each is completable in roughly a ' +
  "dozen tool calls; split a layer into multiple steps if it'd need more than that). Call this once you and " +
  'the human have converged; it can be called again to revise. The document always starts in draft status; ' +
  'only the human can approve it.';

export function createWritePlanExecute(sessionInfo: { sessionKey: string; sessionId: string; requirementsPath: string }) {
  return async ({ markdownBody, steps }: z.infer<typeof writePlanSchema>): Promise<string> => {
    await fs.mkdir(config.plansDir, { recursive: true });
    const filePath = path.join(config.plansDir, `${sessionInfo.sessionKey}.md`);

    let createdDate = new Date().toISOString().slice(0, 10);
    // Carried over from any existing file — in particular `jira`, which
    // records ticket keys already created from a previous version of this
    // plan (see jira/create-tickets-from-plan.ts). A revision must not
    // silently drop that mapping, or the next "Create tickets in Jira"
    // click would re-create duplicates for every step.
    let existingJira: unknown;
    try {
      const existing = await fs.readFile(filePath, 'utf8');
      const parsed = matter(existing);
      if (typeof parsed.data.created === 'string') createdDate = parsed.data.created;
      existingJira = parsed.data.jira;
    } catch {
      // no existing file — use today's date, no prior jira record
    }

    const frontmatter = {
      ticket: sessionInfo.sessionKey,
      status: 'draft',
      created: createdDate,
      'author-agent': 'plan',
      session: sessionInfo.sessionId,
      'requirements-doc': sessionInfo.requirementsPath,
      steps,
      ...(existingJira ? { jira: existingJira } : {}),
    };

    const fileContents = matter.stringify(`\n${markdownBody.trim()}\n`, frontmatter);
    await fs.writeFile(filePath, fileContents, 'utf8');

    return `Wrote ${path.relative(config.harnessRoot, filePath)} (status: draft). Awaiting human approval.`;
  };
}

export function createWritePlanTool(sessionInfo: { sessionKey: string; sessionId: string; requirementsPath: string }) {
  return tool({
    description: writePlanDescription,
    inputSchema: writePlanSchema,
    execute: createWritePlanExecute(sessionInfo),
  });
}
