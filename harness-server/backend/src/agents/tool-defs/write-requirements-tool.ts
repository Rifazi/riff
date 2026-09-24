import { promises as fs } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { tool } from 'ai';
import { z } from 'zod';
import { config } from '../../config.js';

export const writeRequirementsSchema = z.object({
  markdownBody: z.string().describe('The requirements doc body in markdown, following the agreed template'),
  relatedDocs: z
    .array(z.string())
    .describe('Repo-relative paths of docs/*.md files this requirement is grounded in, e.g. ["docs/ingestion/invoices.md"]'),
});
export const writeRequirementsDescription =
  'Write (or overwrite) the requirements document for this session. Pass the full markdown BODY only ' +
  '(problem statement, affected layers, acceptance criteria, open questions, non-goals, links) — do not ' +
  'include YAML frontmatter, it is generated for you. Call this once you and the human have converged; ' +
  'it can be called again to revise. The document always starts in draft status; only the human can approve it.';

/**
 * The only write capability granted to the requirements agent. It only ever
 * writes artifacts/requirements/<sessionKey>.md, in this harness project —
 * never anything in the Customer-EDI checkout (src/, infra/, docs/, or
 * anywhere else). Approval (status: draft -> approved) is a separate,
 * human-only backend endpoint; this tool can never set status to "approved"
 * itself.
 */
export function createWriteRequirementsExecute(sessionInfo: { sessionKey: string; sessionId: string }) {
  return async ({ markdownBody, relatedDocs }: z.infer<typeof writeRequirementsSchema>): Promise<string> => {
    await fs.mkdir(config.requirementsDir, { recursive: true });
    const filePath = path.join(config.requirementsDir, `${sessionInfo.sessionKey}.md`);

    let createdDate = new Date().toISOString().slice(0, 10);
    try {
      const existing = await fs.readFile(filePath, 'utf8');
      const parsed = matter(existing);
      if (typeof parsed.data.created === 'string') createdDate = parsed.data.created;
    } catch {
      // no existing file — use today's date
    }

    const frontmatter = {
      ticket: sessionInfo.sessionKey,
      status: 'draft',
      created: createdDate,
      'author-agent': 'requirements',
      session: sessionInfo.sessionId,
      'related-docs': relatedDocs,
    };

    const fileContents = matter.stringify(`\n${markdownBody.trim()}\n`, frontmatter);
    await fs.writeFile(filePath, fileContents, 'utf8');

    return `Wrote ${path.relative(config.harnessRoot, filePath)} (status: draft). Awaiting human approval.`;
  };
}

export function createWriteRequirementsTool(sessionInfo: { sessionKey: string; sessionId: string }) {
  return tool({
    description: writeRequirementsDescription,
    inputSchema: writeRequirementsSchema,
    execute: createWriteRequirementsExecute(sessionInfo),
  });
}
