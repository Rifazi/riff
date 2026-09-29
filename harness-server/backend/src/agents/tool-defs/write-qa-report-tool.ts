import { promises as fs } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { tool } from 'ai';
import { z } from 'zod';
import { config } from '../../config.js';

export const writeQaReportSchema = z.object({
  markdownBody: z.string(),
  result: z.enum(['pass', 'fail', 'pass-with-notes']),
  lint: z.enum(['pass', 'fail']),
  unitTests: z.enum(['pass', 'fail']),
  integrationTests: z.enum(['pass', 'fail', 'skipped', 'not-applicable']),
  blockingFindings: z
    .array(z.string())
    .describe(
      'One entry per thing the coding agent must fix: unmet acceptance criteria, failing checks, skipped ' +
        '"Docs to update". Each a single line naming the file (and line if known) and the fix. Empty if none. ' +
        'This list — not the report body — is what gets sent back to the coding agent.'
    ),
});
export const writeQaReportDescription =
  'Write (or overwrite) the QA report for this session. Pass the full markdown BODY only (summary, ' +
  'acceptance-criteria checklist, findings) — frontmatter is generated for you. This is the only file this ' +
  'tool can write; it never touches source files.';

export function createWriteQaReportExecute(sessionInfo: {
  sessionKey: string;
  sessionId: string;
  branch: string;
  requirementsPath: string;
}) {
  return async ({
    markdownBody,
    result,
    lint,
    unitTests,
    integrationTests,
    blockingFindings,
  }: z.infer<typeof writeQaReportSchema>): Promise<string> => {
    await fs.mkdir(config.qaReportsDir, { recursive: true });
    const filePath = path.join(config.qaReportsDir, `${sessionInfo.sessionKey}.md`);

    let createdDate = new Date().toISOString().slice(0, 10);
    try {
      const existing = await fs.readFile(filePath, 'utf8');
      const parsed = matter(existing);
      if (typeof parsed.data.created === 'string') createdDate = parsed.data.created;
    } catch {
      // no existing file
    }

    const frontmatter = {
      ticket: sessionInfo.sessionKey,
      status: 'pending-review',
      result,
      created: createdDate,
      session: sessionInfo.sessionId,
      branch: sessionInfo.branch,
      'requirements-doc': sessionInfo.requirementsPath,
      lint,
      'unit-tests': unitTests,
      'integration-tests': integrationTests,
      'blocking-findings': blockingFindings,
    };

    const fileContents = matter.stringify(`\n${markdownBody.trim()}\n`, frontmatter);
    await fs.writeFile(filePath, fileContents, 'utf8');
    const relPath = path.relative(config.harnessRoot, filePath);

    return `Wrote ${relPath} (result: ${result}). Awaiting human review.`;
  };
}

export function createWriteQaReportTool(sessionInfo: {
  sessionKey: string;
  sessionId: string;
  branch: string;
  requirementsPath: string;
}) {
  return tool({
    description: writeQaReportDescription,
    inputSchema: writeQaReportSchema,
    execute: createWriteQaReportExecute(sessionInfo),
  });
}
