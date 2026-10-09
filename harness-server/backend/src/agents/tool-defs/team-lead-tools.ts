import { existsSync } from 'node:fs';
import { tool } from 'ai';
import { z } from 'zod';
import { getSession, mutateSession } from '../../sessions/session-store.js';
import type { CodingTeamMember, CodingTeamState, SessionRecord } from '../../sessions/session.js';
import {
  commitCount,
  commitLogAgainstBase,
  deleteBranch,
  diffAgainstBase,
  diffStatAgainstBase,
  mergeBranch,
  removeWorktree,
  shortStatus,
  withRepoLock,
} from '../../repo/git.js';
import { isTeamRunning, memberWorktree, wakeTeam } from '../team/team-state.js';
import {
  dropProblem,
  isSettled,
  mergeProblem,
  roundOutcome,
  sendBackProblem,
  startable,
  teamStatusLines,
} from '../team/lead-core.js';

// The coding lead's tools for the team he assigned (assign_team): he
// tracks every workstream's branch, reviews what each one built, and is the
// one who merges it into the session branch, sends it back, or takes its
// steps back. The runner (team/coding-team.ts) only builds; it starts a
// workstream once the lead has merged what it depends on.

export interface TeamLeadDeps {
  sessionId: string;
  repoRoot: string;
}

const DIFF_CHARS = 20_000;
const FILE_DIFF_CHARS = 40_000;

async function load(sessionId: string): Promise<{ session: SessionRecord; team: CodingTeamState; branch: string }> {
  const session = await getSession(sessionId);
  if (!session) throw new Error('Session not found.');
  if (!session.codingTeam) throw new Error('There is no coding team this round — assign_team creates one.');
  if (!session.branch) throw new Error("The session branch doesn't exist yet — the team creates it when it starts.");
  return { session, team: session.codingTeam, branch: session.branch };
}

async function branchExists(repoRoot: string, sessionBranch: string, branch: string): Promise<number | null> {
  if (!branch) return null;
  try {
    return await commitCount(repoRoot, sessionBranch, branch);
  } catch {
    return null;
  }
}

async function commitsAheadOf(repoRoot: string, sessionBranch: string, members: CodingTeamMember[]): Promise<Map<string, number>> {
  const ahead = new Map<string, number>();
  for (const m of members) {
    if (m.status === 'merged' || m.status === 'dropped') continue;
    const n = await branchExists(repoRoot, sessionBranch, m.branch);
    if (n !== null) ahead.set(m.id, n);
  }
  return ahead;
}

/**
 * Outside a team run (the lead's turn came from the human or coordinator),
 * a merge or send-back can leave work for the team: mark the round
 * "assigned" again with a new startedAt so the Coding tab starts it once
 * this turn ends. If nothing is left to do, settle the round instead.
 */
async function settleIfIdle(sessionId: string): Promise<'resumes' | 'running' | 'done' | 'idle'> {
  if (isTeamRunning(sessionId)) {
    wakeTeam(sessionId);
    return 'running';
  }
  let result: 'resumes' | 'done' | 'idle' = 'idle';
  await mutateSession(sessionId, (s) => {
    const team = s.codingTeam;
    if (!team) return;
    // A run that ended before the lead merged a dependency left its
    // dependents blocked; merged now, they can go.
    for (const m of team.members) {
      if (m.status === 'blocked' && m.dependsOn.every((d) => team.members.find((x) => x.id === d)?.status === 'merged')) {
        m.status = 'waiting';
        m.note = null;
      }
    }
    if (startable(team.members).length > 0) {
      team.status = 'assigned';
      team.startedAt = new Date().toISOString();
      team.finishedAt = null;
      result = 'resumes';
    } else if (team.members.every((m) => isSettled(m.status))) {
      team.status = roundOutcome(team.members);
      team.finishedAt = new Date().toISOString();
      if (team.status === 'done') result = 'done';
    }
  });
  return result;
}

const whenTeamMoves = (state: Awaited<ReturnType<typeof settleIfIdle>>) =>
  state === 'resumes' ? ' The team picks it up as soon as your turn ends.' : state === 'running' ? ' The team picks it up now.' : '';

// --- team_status ---------------------------------------------------------

export const teamStatusSchema = z.object({});
export const teamStatusDescription =
  "The coding team's current state: every workstream's status, branch, commits ahead of the session branch, " +
  'steps, dependencies and notes. You are responsible for tracking these branches until each is merged or dropped.';

export function createTeamStatusExecute(deps: TeamLeadDeps) {
  return async (): Promise<string> => {
    const { team, branch } = await load(deps.sessionId);
    const ahead = await commitsAheadOf(deps.repoRoot, branch, team.members);
    return `Round ${team.round} (${team.kind}), ${team.status}, merging into ${branch}:\n${teamStatusLines(team.members, ahead)}`;
  };
}

// --- review_workstream ---------------------------------------------------

export const reviewWorkstreamSchema = z.object({
  id: z.string().describe('The workstream id'),
  path: z
    .string()
    .optional()
    .describe('Show the full diff of just this repo-relative file instead of the overview of every change'),
});
export const reviewWorkstreamDescription =
  "What a workstream's branch changes compared with the session branch: its commits, diff stat and diff (one " +
  'line of context; pass path for one file in full context). For a failed one, also what it left uncommitted. ' +
  'Review a branch before you merge it or send it back.';

export function createReviewWorkstreamExecute(deps: TeamLeadDeps) {
  return async ({ id, path }: z.infer<typeof reviewWorkstreamSchema>): Promise<string> => {
    const { session, team, branch } = await load(deps.sessionId);
    const member = team.members.find((m) => m.id === id);
    if (!member) throw new Error(`There is no workstream "${id}" in this round.`);
    if (member.status === 'merged') throw new Error(`"${id}" is already merged — its changes are on ${branch}.`);
    if ((await branchExists(deps.repoRoot, branch, member.branch)) === null) {
      throw new Error(`"${id}" has no branch yet (${member.status}) — nothing to review.`);
    }

    if (path) {
      const diff = await diffAgainstBase(deps.repoRoot, member.branch, branch, [path]);
      if (!diff.trim()) return `${member.branch} doesn't change ${path}.`;
      return diff.length > FILE_DIFF_CHARS ? `${diff.slice(0, FILE_DIFF_CHARS)}\n… (diff truncated)` : diff;
    }

    const [log, stat, diff] = await Promise.all([
      commitLogAgainstBase(deps.repoRoot, member.branch, branch),
      diffStatAgainstBase(deps.repoRoot, member.branch, branch),
      diffAgainstBase(deps.repoRoot, member.branch, branch, [], 1),
    ]);
    const steps = member.stepIds
      .map((sid) => {
        const step = session.codingPlan?.find((s) => s.id === sid);
        return `- ${sid}: ${step?.status ?? 'pending'}${step?.title ? ` — ${step.title}` : ''}`;
      })
      .join('\n');
    const worktree = memberWorktree(deps.sessionId, team, member);
    const leftover =
      member.status !== 'ready' && existsSync(worktree) ? (await shortStatus(worktree)).trim() : '';
    return [
      `${member.id} (${member.title}) — ${member.status}, branch ${member.branch}`,
      `Steps:\n${steps}`,
      `Commits (${log.length}):\n${log.map((c) => `- ${c.hash.slice(0, 8)} ${c.message.split('\n')[0]}`).join('\n') || '- (none)'}`,
      leftover ? `Uncommitted in its checkout:\n${leftover}` : '',
      `Diff stat:\n${stat.trim() || '(no changes)'}`,
      diff.length > DIFF_CHARS
        ? `Diff (first ${DIFF_CHARS} chars — pass path for a file in full):\n${diff.slice(0, DIFF_CHARS)}\n…`
        : `Diff:\n${diff}`,
    ]
      .filter(Boolean)
      .join('\n\n');
  };
}

// --- merge_workstream ----------------------------------------------------

export const mergeWorkstreamSchema = z.object({ id: z.string().describe('The workstream id to merge') });
export const mergeWorkstreamDescription =
  "Merge a finished workstream's branch into the session branch (a --no-ff merge commit), then remove its " +
  "checkout and branch and mark its steps done. A failed one can be merged too once you've checked its steps " +
  'are really done. ' +
  'Review it first. Workstreams that depend on it start once it is ' +
  'merged. The main checkout must be on the session branch with nothing uncommitted. A conflicting merge is ' +
  'aborted and reported; nothing is left half-merged.';

export function createMergeWorkstreamExecute(deps: TeamLeadDeps) {
  return async ({ id }: z.infer<typeof mergeWorkstreamSchema>): Promise<string> => {
    const { team, branch } = await load(deps.sessionId);
    const member = team.members.find((m) => m.id === id);
    const problem = mergeProblem(member, id);
    if (problem) throw new Error(problem);
    const m = member!;

    const setMember = (fn: (x: CodingTeamMember) => void) =>
      mutateSession(deps.sessionId, (s) => {
        const x = s.codingTeam?.members.find((y) => y.id === id);
        if (x) fn(x);
      });

    await setMember((x) => {
      x.status = 'merging';
    });
    const merged = await withRepoLock(deps.repoRoot, () =>
      mergeBranch(deps.repoRoot, m.branch, `chore: merge ${m.id} workstream — ${m.title}`, branch),
    );
    if (!merged.ok) {
      const reason = merged.error.split('\n')[0];
      await setMember((x) => {
        x.status = m.status;
        x.note = `Merge failed: ${reason}`;
      });
      throw new Error(
        `Not merged — ${reason}. If it's a conflict, send it back with what to reconcile, or fix the session branch and try again.`,
      );
    }
    await withRepoLock(deps.repoRoot, async () => {
      await removeWorktree(deps.repoRoot, memberWorktree(deps.sessionId, team, m));
      await deleteBranch(deps.repoRoot, m.branch);
    });
    await mutateSession(deps.sessionId, (s) => {
      const x = s.codingTeam?.members.find((y) => y.id === id);
      if (!x) return;
      x.status = 'merged';
      x.note = null;
      x.finishedAt = new Date().toISOString();
      for (const step of s.codingPlan ?? []) if (x.stepIds.includes(step.id)) step.status = 'done';
    });
    const state = await settleIfIdle(deps.sessionId);
    const after = await getSession(deps.sessionId);
    const unblocked = startable(after?.codingTeam?.members ?? []).filter((x) => x.dependsOn.includes(id));
    return (
      `Merged ${m.branch} into ${branch}; its steps are done.` +
      (unblocked.length ? ` ${unblocked.map((x) => x.id).join(', ')} can start now.${whenTeamMoves(state)}` : '') +
      (state === 'done' ? ' Every workstream in this round is now merged or dropped.' : '')
    );
  };
}

// --- send_back_workstream ------------------------------------------------

export const sendBackWorkstreamSchema = z.object({
  id: z.string().describe('The workstream id'),
  feedback: z
    .string()
    .describe(
      'Exactly what to change or finish, specific enough to act on alone: which files, what is wrong, what done ' +
        'looks like. The engineer sees this and its own branch, not your review.',
    ),
});
export const sendBackWorkstreamDescription =
  'Send a ready or failed workstream back to its engineer with your feedback. It continues on the same branch ' +
  '(a failed one starts a fresh conversation with a handoff) and comes back to you for review when done. ' +
  'Limited to a few times per workstream.';

export function createSendBackWorkstreamExecute(deps: TeamLeadDeps) {
  return async ({ id, feedback }: z.infer<typeof sendBackWorkstreamSchema>): Promise<string> => {
    const { team } = await load(deps.sessionId);
    const problem = sendBackProblem(
      team.members.find((m) => m.id === id),
      id,
    );
    if (problem) throw new Error(problem);
    if (!feedback.trim()) throw new Error('Say what to fix — the engineer only sees your feedback.');
    await mutateSession(deps.sessionId, (s) => {
      const m = s.codingTeam?.members.find((x) => x.id === id);
      if (!m) return;
      // A failed run likely ran out of steps or context: start it over from a
      // handoff instead of replaying the same history (workstream-agent.ts).
      if (m.status === 'failed') {
        m.history = [];
        m.claudeSessionId = null;
        m.contextStartEntryId = null;
      }
      m.feedback = feedback.trim();
      m.sendBacks = (m.sendBacks ?? 0) + 1;
      m.status = 'waiting';
      m.note = 'Sent back by the lead.';
      m.startedAt = null;
      m.finishedAt = null;
    });
    const state = await settleIfIdle(deps.sessionId);
    return `Sent ${id} back with your feedback.${whenTeamMoves(state) || ' It restarts when the team resumes.'}`;
  };
}

// --- drop_workstreams ----------------------------------------------------

export const dropWorkstreamsSchema = z.object({
  ids: z.array(z.string()).min(1).describe('Workstream ids to drop, including any that depend on them'),
  reason: z.string().describe('Why, in a sentence — shown to the human on the team board'),
});
export const dropWorkstreamsDescription =
  "Take workstreams back from the team: their checkouts and unmerged branches are deleted and their steps go " +
  'back to pending on the checklist for you to build yourself after the team. Use it for a workstream that ' +
  "failed and isn't worth retrying, or a split that turned out wrong. Review first if anything on the branch is " +
  'worth keeping — it is discarded.';

export function createDropWorkstreamsExecute(deps: TeamLeadDeps) {
  return async ({ ids, reason }: z.infer<typeof dropWorkstreamsSchema>): Promise<string> => {
    const { team } = await load(deps.sessionId);
    const unique = [...new Set(ids)];
    const problem = dropProblem(team.members, unique);
    if (problem) throw new Error(problem);
    const dropped = team.members.filter((m) => unique.includes(m.id));
    await withRepoLock(deps.repoRoot, async () => {
      for (const m of dropped) {
        await removeWorktree(deps.repoRoot, memberWorktree(deps.sessionId, team, m));
        if (m.branch) await deleteBranch(deps.repoRoot, m.branch);
      }
    });
    await mutateSession(deps.sessionId, (s) => {
      for (const m of s.codingTeam?.members ?? []) {
        if (!unique.includes(m.id)) continue;
        m.status = 'dropped';
        m.note = `Dropped by the lead: ${reason.trim()}`;
        m.finishedAt = new Date().toISOString();
        m.feedback = null;
        for (const step of s.codingPlan ?? []) if (m.stepIds.includes(step.id)) step.status = 'pending';
      }
    });
    const state = await settleIfIdle(deps.sessionId);
    const steps = dropped.flatMap((m) => m.stepIds);
    return (
      `Dropped ${unique.join(', ')}. Steps back on the checklist for you: ${steps.join(', ')}.` +
      (state === 'done' ? ' Every workstream in this round is now merged or dropped.' : '')
    );
  };
}

// --- build_solo ----------------------------------------------------------

export const buildSoloSchema = z.object({
  reason: z.string().describe("One line on why this doesn't split across a team, e.g. \"every step edits the store\""),
});
export const buildSoloDescription =
  'Record that you will build this work yourself rather than split it across a team (assign_team). Until you ' +
  'decide one way or the other, your write tools are locked.';

export function createBuildSoloExecute(deps: { sessionId: string }) {
  return async ({ reason }: z.infer<typeof buildSoloSchema>): Promise<string> => {
    if (!reason.trim()) throw new Error('Give a one-line reason.');
    await mutateSession(deps.sessionId, (s) => {
      s.teamDecisionPending = false;
    });
    return 'Noted — you build it yourself. Your write tools are unlocked.';
  };
}

/** The guard the lead's write tools run first while a split decision is pending. */
export function teamDecisionGuard(sessionId: string): () => Promise<void> {
  return async () => {
    const s = await getSession(sessionId);
    if (s?.teamDecisionPending) {
      throw new Error(
        'Decide how this work gets built before changing anything: call assign_team to split it across ' +
          'engineers, or build_solo with a one-line reason to build it yourself.',
      );
    }
  };
}

// --- AI SDK wrappers -----------------------------------------------------

export function createTeamLeadTools(deps: TeamLeadDeps) {
  return {
    team_status: tool({ description: teamStatusDescription, inputSchema: teamStatusSchema, execute: createTeamStatusExecute(deps) }),
    review_workstream: tool({
      description: reviewWorkstreamDescription,
      inputSchema: reviewWorkstreamSchema,
      execute: createReviewWorkstreamExecute(deps),
    }),
    merge_workstream: tool({
      description: mergeWorkstreamDescription,
      inputSchema: mergeWorkstreamSchema,
      execute: createMergeWorkstreamExecute(deps),
    }),
    send_back_workstream: tool({
      description: sendBackWorkstreamDescription,
      inputSchema: sendBackWorkstreamSchema,
      execute: createSendBackWorkstreamExecute(deps),
    }),
    drop_workstreams: tool({
      description: dropWorkstreamsDescription,
      inputSchema: dropWorkstreamsSchema,
      execute: createDropWorkstreamsExecute(deps),
    }),
  };
}

export const TEAM_LEAD_TOOL_NAMES = ['team_status', 'review_workstream', 'merge_workstream', 'send_back_workstream', 'drop_workstreams'];

export function createBuildSoloTool(deps: { sessionId: string }) {
  return tool({ description: buildSoloDescription, inputSchema: buildSoloSchema, execute: createBuildSoloExecute(deps) });
}
