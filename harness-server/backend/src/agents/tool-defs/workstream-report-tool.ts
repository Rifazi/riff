import { tool } from 'ai';
import { z } from 'zod';
import { mutateSession } from '../../sessions/session-store.js';
import type { WorkstreamReport } from '../../sessions/session.js';

export const reportWorkstreamSchema = z.object({
  summary: z.string().describe('At most 3 sentences: what your branch builds and how it fits the feature.'),
  steps: z
    .array(z.object({ id: z.string(), done: z.string().describe('One line: what you changed for this step, and where') }))
    .describe('One entry per step of yours.'),
  interfaces: z
    .array(z.string())
    .describe(
      'What other code calls or imports from your branch, one per line: "path — name(signature): what it is for". ' +
        'Only what a teammate or the lead needs to use it, not internals. Empty if nothing.',
    ),
  checks: z.string().describe('One line: the last lint and unit test results on your branch.'),
  forLead: z
    .array(z.string())
    .describe('One line each: deviations from the plan, risks, anything the lead should look at closely. Empty if none.'),
});

export const reportWorkstreamDescription =
  'Hand your branch to the lead: what you built, the interfaces others use, and your last check results. The lead ' +
  'reviews from this and the diff, and the workstreams that depend on yours get your summary and interfaces ' +
  'instead of reading your files. Call it once, last, after your final commit; calling it again replaces it.';

export function createReportWorkstreamExecute(deps: { sessionId: string; memberId: string }) {
  return async (input: z.infer<typeof reportWorkstreamSchema>): Promise<string> => {
    const report: WorkstreamReport = {
      summary: input.summary.trim(),
      steps: input.steps.map((s) => ({ id: s.id.trim(), done: s.done.trim() })),
      interfaces: input.interfaces.map((i) => i.trim()).filter(Boolean),
      checks: input.checks.trim(),
      forLead: input.forLead.map((n) => n.trim()).filter(Boolean),
    };
    await mutateSession(deps.sessionId, (s) => {
      const m = s.codingTeam?.members.find((x) => x.id === deps.memberId);
      if (m) m.report = report;
    });
    return `Reported: ${report.steps.length} steps, ${report.interfaces.length} interfaces. End your turn now.`;
  };
}

export function createReportWorkstreamTool(deps: { sessionId: string; memberId: string }) {
  return tool({ description: reportWorkstreamDescription, inputSchema: reportWorkstreamSchema, execute: createReportWorkstreamExecute(deps) });
}
