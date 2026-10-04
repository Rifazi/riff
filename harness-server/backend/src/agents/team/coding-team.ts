import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { config } from '../../config.js';
import { getApp } from '../../apps/apps-store.js';
import { baseBranchFor } from '../../apps/apps.js';
import { appendTeamTranscriptEntry, getSession, listSessions, mutateSession, updateSession } from '../../sessions/session-store.js';
import { getRoleModelConfig } from '../../settings/settings-store.js';
import { lightModelFor, planStepEfforts } from '../model-routing.js';
import type { CodingTeamMember, CodingTeamState, SessionRecord, TeamMemberStatus } from '../../sessions/session.js';
import {
  addWorktree,
  assertOnBranch,
  commitAll,
  commitCount,
  createBranch,
  deleteBranch,
  hasUncommittedChanges,
  mergeBranch,
  removeWorktree,
  withRepoLock,
} from '../../repo/git.js';
import { suggestedBranchName } from '../coding-agent.js';
import type { AgentEvent } from '../sdk-client.js';
import { runWorkstreamAgent } from './workstream-agent.js';

export type TeamEvent =
  | { type: 'team_member_event'; memberId: string; event: AgentEvent }
  | { type: 'team_member_status'; memberId: string; status: TeamMemberStatus; note: string | null }
  | { type: 'team_status'; status: 'running' | 'done' | 'needs_attention' }
  | { type: 'error'; message: string };

// Which sessions have a team run in flight in this process — the persisted
// status alone can't tell a live run from one the server was killed during.
const running = new Set<string>();

export function isTeamRunning(sessionId: string): boolean {
  return running.has(sessionId);
}

export function worktreeDirFor(sessionId: string, memberId?: string): string {
  const dir = path.join(config.stateDir, 'worktrees', sessionId);
  return memberId ? path.join(dir, memberId) : dir;
}

// A member's branch suffix and worktree name. Round 1 keeps the bare id (as
// before rounds existed); later rounds are prefixed so an earlier round's
// unmerged branch or worktree never collides with the new one.
function memberKey(team: CodingTeamState, member: CodingTeamMember): string {
  return team.round > 1 ? `r${team.round}-${member.id}` : member.id;
}

/**
 * Runs the workstreams the coding lead assigned (assign_team) as a coding
 * team: one agent per workstream, each in its own git worktree on its own branch off the
 * session branch, started as soon as everything it depends on has merged.
 * Each finished member's branch is merged back into the session branch
 * (serialized per repo). Members that haven't merged — failed, or cut off
 * by a restart — are picked up again by calling this again.
 */
export async function runCodingTeam(sessionId: string, emit: (event: TeamEvent) => void): Promise<void> {
  if (running.has(sessionId)) throw new Error('The coding team is already running for this session.');
  running.add(sessionId);
  try {
    await run(sessionId, emit);
  } finally {
    running.delete(sessionId);
  }
}

async function run(sessionId: string, emit: (event: TeamEvent) => void): Promise<void> {
  let session = await getSession(sessionId);
  if (!session) throw new Error('Session not found.');
  if (session.requirementsStatus !== 'approved' || session.planStatus !== 'approved') {
    throw new Error('Requirements and plan must both be approved before the coding team can start.');
  }
  if (!session.codingTeam) throw new Error("The lead hasn't split this work across a team.");
  const app = await getApp(session.appId);

  // The main checkout stays on the session branch the whole time: every
  // member's branch is merged into it there.
  if (!session.branch) {
    const branch = suggestedBranchName(session);
    await withRepoLock(app.repoRoot, () => createBranch(app.repoRoot, branch, baseBranchFor(app)));
    session = await updateSession(sessionId, { branch, stage: 'coding-in-progress' });
  } else {
    await assertOnBranch(app.repoRoot, session.branch);
    if (await hasUncommittedChanges(app.repoRoot)) {
      throw new Error(`Branch ${session.branch} has uncommitted changes in ${app.repoRoot} — commit or stash them first.`);
    }
    session = await updateSession(sessionId, { stage: 'coding-in-progress' });
  }
  const sessionBranch = session.branch!;

  session = await mutateSession(sessionId, (s) => {
    const team = s.codingTeam!;
    team.status = 'running';
    team.finishedAt = null;
    // Everyone who hasn't merged runs (again), keeping their history.
    for (const m of team.members) {
      if (m.status === 'merged') continue;
      m.branch = `${sessionBranch}--${memberKey(team, m)}`;
      m.status = 'waiting';
      m.note = null;
      m.startedAt = null;
      m.finishedAt = null;
    }
  });
  const team = session.codingTeam!;
  emit({ type: 'team_status', status: 'running' });

  const setStatus = async (memberId: string, status: TeamMemberStatus, note: string | null = null) => {
    await mutateSession(sessionId, (s) => {
      const m = s.codingTeam?.members.find((x) => x.id === memberId);
      if (!m) return;
      m.status = status;
      m.note = note;
      if (status === 'running') m.startedAt = new Date().toISOString();
      if (status === 'merged' || status === 'failed') m.finishedAt = new Date().toISOString();
      if (status === 'merged') {
        for (const step of s.codingPlan ?? []) if (m.stepIds.includes(step.id)) step.status = 'done';
      }
    });
    emit({ type: 'team_member_status', memberId, status, note });
  };

  const members = session.codingTeam!.members;
  const byId = new Map(members.map((m) => [m.id, m]));
  const outcomes = new Map<string, Promise<boolean>>();

  const runMember = (member: CodingTeamMember): Promise<boolean> => {
    const existing = outcomes.get(member.id);
    if (existing) return existing;
    const outcome = (async () => {
      if (member.status === 'merged') return true;
      const deps = await Promise.all(member.dependsOn.map((id) => runMember(byId.get(id)!)));
      if (!deps.every(Boolean)) {
        const failed = member.dependsOn.filter((_, i) => !deps[i]);
        await setStatus(member.id, 'blocked', `Waiting on ${failed.join(', ')}, which didn't merge.`);
        return false;
      }
      try {
        return await runOne(member);
      } catch (err) {
        await setStatus(member.id, 'failed', err instanceof Error ? err.message : String(err));
        return false;
      }
    })();
    outcomes.set(member.id, outcome);
    return outcome;
  };

  const runOne = async (member: CodingTeamMember): Promise<boolean> => {
    const worktreePath = worktreeDirFor(sessionId, memberKey(team, member));
    await fs.mkdir(path.dirname(worktreePath), { recursive: true });
    // Branches off the session branch as it is now — i.e. including every
    // dependency that has already merged.
    await withRepoLock(app.repoRoot, () => addWorktree(app.repoRoot, worktreePath, member.branch, sessionBranch));
    // Lint/tests/prettier need the repo's installed dependencies.
    const modules = path.join(app.repoRoot, 'node_modules');
    const linked = path.join(worktreePath, 'node_modules');
    if (existsSync(modules) && !existsSync(linked)) await fs.symlink(modules, linked, 'dir');

    await setStatus(member.id, 'running');
    const latest = (await getSession(sessionId))!;
    const fresh = latest.codingTeam!.members.find((m) => m.id === member.id)!;
    const onEvent = (event: AgentEvent) => emit({ type: 'team_member_event', memberId: member.id, event });

    // Light-model routing: a workstream whose steps are all tagged light
    // starts on the cheaper model — only on its first run; a resumed one
    // gets the full model. If the light run throws or leaves any of its
    // steps unfinished, the full model picks up the same conversation.
    const lightModel = lightModelFor(await getRoleModelConfig('coding'));
    const efforts = await planStepEfforts(latest);
    const light =
      lightModel && fresh.transcript.length === 0 && fresh.stepIds.every((id) => efforts.get(id) === 'light') ? lightModel : null;

    if (light) {
      await appendTeamTranscriptEntry(sessionId, member.id, { role: 'system', text: `Light workstream — running on ${light}.` });
      let failed = false;
      try {
        await runWorkstreamAgent({ session: latest, app, member: fresh, teammates: latest.codingTeam!.members, worktreePath, onEvent, model: light });
      } catch {
        failed = true;
      }
      const after = (await getSession(sessionId))!;
      const done = fresh.stepIds.every((id) => after.codingPlan?.find((s) => s.id === id)?.status === 'done');
      if (failed || !done) {
        const { model } = await getRoleModelConfig('coding');
        await appendTeamTranscriptEntry(sessionId, member.id, {
          role: 'system',
          text: `↑ ${light} didn't finish this workstream — handing it to ${model}.`,
        });
        const again = after.codingTeam!.members.find((m) => m.id === member.id)!;
        await runWorkstreamAgent({
          session: after,
          app,
          member: again,
          teammates: after.codingTeam!.members,
          worktreePath,
          onEvent,
          prompt:
            `A lighter model (${light}) worked on this workstream just now but didn't finish it cleanly. Review what ` +
            'it did in your checkout — commits and uncommitted changes — fix anything wrong or missing, then finish ' +
            'the remaining steps and leave nothing uncommitted.',
        });
      }
    } else {
      await runWorkstreamAgent({ session: latest, app, member: fresh, teammates: latest.codingTeam!.members, worktreePath, onEvent });
    }

    if (await hasUncommittedChanges(worktreePath)) {
      await commitAll(worktreePath, `chore(${member.id}): commit remaining workstream changes`);
    }
    if ((await commitCount(worktreePath, sessionBranch, member.branch)) === 0) {
      await setStatus(member.id, 'failed', 'Finished without committing anything — see its log.');
      return false;
    }

    await setStatus(member.id, 'merging');
    const merged = await withRepoLock(app.repoRoot, () =>
      mergeBranch(app.repoRoot, member.branch, `chore: merge ${member.id} workstream — ${member.title}`)
    );
    if (!merged.ok) {
      await setStatus(member.id, 'failed', `Couldn't merge ${member.branch} into ${sessionBranch}: ${merged.error.split('\n')[0]}`);
      return false;
    }
    await withRepoLock(app.repoRoot, async () => {
      await removeWorktree(app.repoRoot, worktreePath);
      await deleteBranch(app.repoRoot, member.branch);
    });
    await setStatus(member.id, 'merged');
    return true;
  };

  const results = await Promise.all(members.map(runMember));
  const status = results.every(Boolean) ? 'done' : 'needs_attention';
  await mutateSession(sessionId, (s) => {
    if (s.codingTeam) {
      s.codingTeam.status = status;
      s.codingTeam.finishedAt = new Date().toISOString();
    }
    s.stage = 'coding-review';
  });
  emit({ type: 'team_status', status });
}

/** At server start: any team marked running was cut off by the restart. */
export async function recoverInterruptedTeams(): Promise<void> {
  for (const session of await listSessions()) {
    if (session.codingTeam?.status !== 'running') continue;
    await mutateSession(session.id, (s) => {
      if (!s.codingTeam) return;
      s.codingTeam.status = 'interrupted';
      for (const m of s.codingTeam.members) {
        if (m.status === 'running' || m.status === 'merging' || m.status === 'waiting') {
          m.status = 'waiting';
          m.note = 'Interrupted when the agent server stopped — resume the team to continue.';
        }
      }
    });
  }
}

/** Removes a session's leftover worktrees and member branches (on session delete). */
export async function cleanupTeamWorktrees(session: SessionRecord): Promise<void> {
  const teams = [...session.codingTeamHistory, ...(session.codingTeam ? [session.codingTeam] : [])];
  if (teams.length === 0) return;
  let repoRoot: string | null = null;
  try {
    repoRoot = (await getApp(session.appId)).repoRoot;
  } catch {
    // app removed — just delete the directories
  }
  for (const team of teams) {
    for (const member of team.members) {
      if (member.status === 'merged' || !repoRoot) continue;
      await withRepoLock(repoRoot, () => removeWorktree(repoRoot!, worktreeDirFor(session.id, memberKey(team, member))));
    }
  }
  await fs.rm(worktreeDirFor(session.id), { recursive: true, force: true });
}
