import { promises as fs } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { tool } from 'ai';
import { z } from 'zod';
import { config } from '../../config.js';
import { classifyText } from '../helpers/classifier/classifier.js';

// Labels fed to the on-device NLI classifier to auto-determine step effort.
const EFFORT_LABELS = [
  'light: mechanical change — closely follows an existing pattern, no design decisions (docs, config, rename, test copy)',
  'standard: requires judgment — new logic, architecture, security, migrations, cross-cutting or ambiguous scope',
];

async function classifyEffort(title: string): Promise<'light' | 'standard'> {
  try {
    const result = await classifyText({ text: title, labels: EFFORT_LABELS, mode: 'single' });
    return result.selected[0]?.label.startsWith('light') ? 'light' : 'standard';
  } catch {
    return 'standard';
  }
}

export const planStepSchema = z.object({
  id: z.string().describe('Short stable slug, e.g. "schema", "primary-adapter", "cdk-stateful"'),
  title: z.string().describe('Short human-readable title, e.g. "Add the acme-inventory JSON schema"'),
  // effort is auto-classified by the on-device NLI model — omit it here
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

    // Auto-classify effort for each step using the on-device NLI classifier.
    // The plan agent no longer needs to reason about light vs standard — the
    // classifier tags it for free, and model-routing.ts reads these tags.
    const stepsWithEffort = await Promise.all(
      steps.map(async (step) => ({ ...step, effort: await classifyEffort(step.title) })),
    );

    const frontmatter = {
      ticket: sessionInfo.sessionKey,
      status: 'draft',
      created: createdDate,
      'author-agent': 'plan',
      session: sessionInfo.sessionId,
      'requirements-doc': sessionInfo.requirementsPath,
      steps: stepsWithEffort,
      ...(existingJira ? { jira: existingJira } : {}),
    };

    const fileContents = matter.stringify(`\n${markdownBody.trim()}\n`, frontmatter);
    await fs.writeFile(filePath, fileContents, 'utf8');

    const lightCount = stepsWithEffort.filter((s) => s.effort === 'light').length;
    return (
      `Wrote ${path.relative(config.harnessRoot, filePath)} (status: draft). ` +
      `${stepsWithEffort.length} steps (${lightCount} light, ${stepsWithEffort.length - lightCount} standard). ` +
      `Awaiting human approval.`
    );
  };
}

export function createWritePlanTool(sessionInfo: { sessionKey: string; sessionId: string; requirementsPath: string }) {
  return tool({
    description: writePlanDescription,
    inputSchema: writePlanSchema,
    execute: createWritePlanExecute(sessionInfo),
  });
}
