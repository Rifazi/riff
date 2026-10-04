import { promises as fs } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { tool } from 'ai';
import { z } from 'zod';
import { config } from '../../config.js';
import { getSession, mutateSession } from '../../sessions/session-store.js';
import type { CodingPlanStep, CodingTeamKind, CodingTeamMember } from '../../sessions/session.js';
import { hasUncommittedChanges } from '../../repo/git.js';
import { validateWorkstreams, workstreamSchema } from '../team/workstreams.js';

export const assignTeamSchema = z.object({
  steps: z
    .array(
      z.object({
        id: z.string().describe('Short stable slug, unique on the checklist, e.g. "fix-report-totals"'),
        title: z.string().describe('Short human-readable title, e.g. "Fix the report totals rounding"'),
        brief: z
          .string()
          .describe(
            'Everything the engineer needs to do this step without asking: what is wrong or missing, where, what to ' +
              'change, and how QA will check it. They see the approved plan but not QA\'s report or your chat.'
          ),
      })
    )
    .optional()
    .describe(
      'New checklist steps for work that isn\'t on the checklist yet — QA\'s findings, or what the human asked for: ' +
        'one step per fix or group of related fixes. Omit to split the checklist\'s unfinished steps as they are ' +
        '(e.g. the approved plan at kickoff).'
    ),
  workstreams: z
    .array(workstreamSchema)
    .min(2)
    .describe(
      'Every unfinished checklist step (including the new ones above) grouped into 2+ workstreams, each built ' +
        'concurrently by its own engineer in an isolated checkout, owning a set of paths no other workstream touches.'
    ),
});

export const assignTeamDescription =
  'Split the remaining coding work across a team of engineers who build it in parallel, instead of building it ' +
  'yourself one step at a time. You are the lead: this is your call to make, at kickoff (the approved plan) and ' +
  'whenever QA sends the branch back (its findings).\n\n' +
  'Split only when it genuinely saves time: two or more groups of steps write completely disjoint sets of files ' +
  '(e.g. an API endpoint and the page that calls it, two unrelated adapters, fixes in unrelated areas), at least two ' +
  'groups can run at the same time, and each is a meaningful chunk, not a one-line change. Small or tightly coupled ' +
  'work, or anything where you aren\'t sure which files a step touches, you build yourself — don\'t call this.\n\n' +
  'For each workstream:\n' +
  '- ownedPaths: every file or directory it will write, new and edited, tests included. Ownership is enforced (an ' +
  'engineer cannot write outside its paths) and no two workstreams may overlap, so be complete, and prefer ' +
  'directories for new code over guessing filenames.\n' +
  '- Shared touch points (package.json and the lockfile, a route or DI registry, a barrel index.ts, shared types or ' +
  'schemas) go to exactly one workstream, usually a small foundation workstream the others list in dependsOn. A ' +
  'dependent workstream starts from the merged result of everything it depends on.\n' +
  '- Docs pages are shared touch points too: give the pages the work updates, including the code-map page ' +
  '(usually docs/architecture.md), to one workstream that depends on the ones whose code they describe.\n' +
  '- If the app has a UI theme, the root entry and the shared UI components go in one workstream the view ' +
  'workstreams depend on.\n\n' +
  'Look before you split: read the plan and search_code / outline_file the areas involved so ownedPaths are right. ' +
  'Commit or discard any uncommitted work first. The call is rejected if paths overlap, an unfinished step is ' +
  'unassigned, or nothing could run in parallel. Once it succeeds, end your turn: tell the human in a few lines who ' +
  'builds what and why. The team starts when your turn ends, and each finished workstream is merged into the ' +
  'session branch; you take follow-ups once they are done. Don\'t write code yourself in the same turn.';

/**
 * Records the lead's split as the session's next team round ("assigned").
 * The Coding tab starts it (agents/team/coding-team.ts) once the lead's turn
 * has ended, so the team never runs alongside the lead in the same checkout.
 */
export function createAssignTeamExecute(deps: { sessionId: string; repoRoot: string; kind: CodingTeamKind }) {
  return async ({ steps: newSteps = [], workstreams }: z.infer<typeof assignTeamSchema>): Promise<string> => {
    const session = await getSession(deps.sessionId);
    if (!session) throw new Error('Session not found.');
    if (session.codingTeam?.status === 'running') throw new Error('A coding team is already running for this session.');
    if (session.branch && (await hasUncommittedChanges(deps.repoRoot))) {
      throw new Error('The branch has uncommitted changes — commit or discard them before handing work to a team.');
    }

    const checklist: CodingPlanStep[] = session.codingPlan ?? (await approvedPlanSteps(session.planPath));
    const taken = new Set(checklist.map((s) => s.id));
    for (const step of newSteps) {
      if (taken.has(step.id)) throw new Error(`Step id "${step.id}" is already on the checklist — pick a new id.`);
      taken.add(step.id);
    }
    const added: CodingPlanStep[] = newSteps.map((s) => ({ id: s.id, title: s.title, brief: s.brief, status: 'pending' }));
    const open = [...checklist, ...added].filter((s) => s.status !== 'done').map((s) => s.id);
    // Thrown before anything is saved, so the model sees why and retries.
    const valid = validateWorkstreams(open, workstreams);

    let round = 1;
    await mutateSession(deps.sessionId, (s) => {
      s.codingPlan = [...checklist, ...added].map((step) => (open.includes(step.id) ? { ...step, status: 'pending' } : step));
      const previous = s.codingTeam;
      // Re-assigning before the team started replaces that split; anything
      // else becomes history and this is the next round.
      if (previous && previous.status !== 'assigned') s.codingTeamHistory.push(previous);
      round = previous ? (previous.status === 'assigned' ? previous.round : previous.round + 1) : 1;
      s.codingTeam = {
        status: 'assigned',
        round,
        kind: deps.kind,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        members: valid.map(
          (ws): CodingTeamMember => ({
            ...ws,
            branch: '',
            status: 'waiting',
            note: null,
            startedAt: null,
            finishedAt: null,
            transcript: [],
            history: [],
            claudeSessionId: null,
          })
        ),
      };
    });

    return (
      `Team assigned (round ${round}): ${valid.map((w) => `${w.id} → ${w.stepIds.join(', ')}`).join('; ')}. ` +
      'End your turn now with a short note to the human on who builds what and why — the team starts when your turn ends.'
    );
  };
}

async function approvedPlanSteps(planPath: string | null): Promise<CodingPlanStep[]> {
  if (!planPath) throw new Error('There is no approved plan to split.');
  const raw = await fs.readFile(path.join(config.harnessRoot, planPath), 'utf8');
  const steps: unknown = matter(raw).data.steps;
  if (!Array.isArray(steps) || steps.length === 0) throw new Error('The approved plan has no steps to split.');
  return (steps as { id: string; title: string }[]).map((s) => ({ id: s.id, title: s.title, status: 'pending' }));
}

export function createAssignTeamTool(deps: { sessionId: string; repoRoot: string; kind: CodingTeamKind }) {
  return tool({ description: assignTeamDescription, inputSchema: assignTeamSchema, execute: createAssignTeamExecute(deps) });
}
