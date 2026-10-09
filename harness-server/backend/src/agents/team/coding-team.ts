import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { getApp } from '../../apps/apps-store.js';
import { baseBranchFor } from '../../apps/apps.js';
import { appendTeamTranscriptEntry, getSession, listSessions, mutateSession, updateSession } from '../../sessions/session-store.js';
import { getRoleModelConfig } from '../../settings/settings-store.js';
import { lightModelFor, planStepEfforts } from '../model-routing.js';
import type {
  CodingTeamMember,
  QaCheckCommand,
  QaReviewerStatus,
  QaTeamCheck,
  SessionRecord,
  TeamMemberStatus,
} from '../../sessions/session.js';
import {
  addWorktree,
  assertOnBranch,
  commitAll,
  commitCount,
  committedPathsOutside,
  createBranch,
  discardPaths,
  hasUncommittedChanges,
  removeWorktree,
  uncommittedPathsOutside,
  withRepoLock,
} from '../../repo/git.js';
import { runCodingAgentTurn, suggestedBranchName } from '../coding-agent.js';
import type { AgentEvent } from '../sdk-client.js';
import { runWorkstreamAgent } from './workstream-agent.js';
import { leadReviewMessage, leadWrapUpMessage, roundOutcome, startable, stuckDependencies } from './lead-core.js';
import {
  isTeamRunning,
  memberKey,
  memberWorktree,
  onMemberRestart,
  onTeamWake,
  ROUND_FINISHING,
  runningTeams,
  untilAborted,
  worktreeDirFor,
} from './team-state.js';

export { isTeamRunning, worktreeDirFor };

// The lead's turns during a run stream on the team board under this id.
export const LEAD_MEMBER_ID = 'lead';

// Shared by the coding team and the QA team (qa-team.ts): one SSE stream
// carrying every member's events, tagged by memberId.
export type TeamEvent =
  | { type: 'team_member_event'; memberId: string; event: AgentEvent }
  | { type: 'team_member_status'; memberId: string; status: TeamMemberStatus | QaReviewerStatus; note: string | null }
  | { type: 'team_check'; command: QaCheckCommand; status: QaTeamCheck['status'] }
  | { type: 'team_status'; status: 'running' | 'done' | 'needs_attention' }
  | { type: 'team_lead'; active: boolean }
  | { type: 'error'; message: string };

/**
 * Runs the workstreams the coding lead assigned (assign_team) as a coding
 * team: one agent per workstream, each in its own git worktree on its own
 * branch off the session branch. The runner only builds. When a workstream
 * finishes (or fails) the lead gets a turn in the main checkout to review
 * it and merge it, send it back or drop it (tool-defs/team-lead-tools.ts);
 * a workstream starts once the lead has merged everything it depends on.
 * Lead turns are one at a time, batching whatever finished meanwhile, while
 * the other engineers keep building. Calling this again resumes whatever
 * hasn't merged.
 */
export async function runCodingTeam(sessionId: string, emit: (event: TeamEvent) => void): Promise<void> {
  if (runningTeams.has(sessionId)) throw new Error('The coding team is already running for this session.');
  runningTeams.add(sessionId);
  try {
    await run(sessionId, emit);
  } finally {
    runningTeams.delete(sessionId);
    onTeamWake(sessionId, null);
    onMemberRestart('coding', sessionId, null);
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

  // The main checkout stays on the session branch the whole time: the lead
  // merges every member's branch into it there.
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
    for (const m of team.members) {
      // Merged and dropped are done with; a ready branch waits for the lead.
      if (m.status === 'merged' || m.status === 'dropped' || m.status === 'ready') continue;
      m.branch = `${sessionBranch}--${memberKey(team, m)}`;
      // Resuming retries a failed member. It likely ran out of steps or
      // context, so it starts from a handoff instead of the same history
      // (workstream-agent.ts detects the cleared state).
      if (m.status === 'failed') {
        m.history = [];
        m.claudeSessionId = null;
        m.contextStartEntryId = null;
      }
      m.status = 'waiting';
      m.note = m.feedback ? 'Sent back by the lead.' : null;
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
      if (status === 'ready' || status === 'failed') m.finishedAt = new Date().toISOString();
    });
    emit({ type: 'team_member_status', memberId, status, note });
  };

  // --- building ---------------------------------------------------------

  // A restart (restartMember below) aborts the member's run and skips the
  // hand-off to the lead: the scheduler resets it and starts it again.
  const buildMember = async (id: string, signal: AbortSignal): Promise<void> => {
    try {
      const latest = (await getSession(sessionId))!;
      const member = latest.codingTeam!.members.find((m) => m.id === id)!;
      const worktreePath = memberWorktree(sessionId, team, member);
      await fs.mkdir(path.dirname(worktreePath), { recursive: true });
      // Branches off the session branch as it is now — i.e. including every
      // dependency the lead has merged.
      await withRepoLock(app.repoRoot, () => addWorktree(app.repoRoot, worktreePath, member.branch, sessionBranch));
      // Lint/tests/prettier need the repo's installed dependencies.
      const modules = path.join(app.repoRoot, 'node_modules');
      const linked = path.join(worktreePath, 'node_modules');
      if (existsSync(modules) && !existsSync(linked)) await fs.symlink(modules, linked, 'dir');

      // Already built (e.g. cut off by a restart after its last commit):
      // goes straight back to the lead.
      const built =
        !member.feedback &&
        member.transcript.length > 0 &&
        member.stepIds.every((sid) => latest.codingPlan?.find((s) => s.id === sid)?.status === 'done') &&
        !(await hasUncommittedChanges(worktreePath)) &&
        (await commitCount(worktreePath, sessionBranch, member.branch)) > 0;
      let runError: string | null = null;
      if (!built) {
        try {
          await Promise.race([build(member, latest, worktreePath, signal), untilAborted(signal)]);
        } catch (err) {
          runError = err instanceof Error ? err.message : String(err);
        }
      }
      // Restarting: what it left in its checkout stays there for the next run.
      if (signal.aborted) return;
      await prepareForLead(member, worktreePath, runError);
    } catch (err) {
      if (signal.aborted) return;
      await setStatus(id, 'failed', err instanceof Error ? err.message : String(err));
    }
  };

  const build = async (member: CodingTeamMember, latest: SessionRecord, worktreePath: string, signal: AbortSignal) => {
    const restartedNow = restarted.delete(member.id);
    await setStatus(member.id, 'running', member.feedback ? 'Working on the lead’s feedback.' : null);
    // The run below reads the feedback from `member`; it's one-shot.
    if (member.feedback) {
      await mutateSession(sessionId, (s) => {
        const m = s.codingTeam?.members.find((x) => x.id === member.id);
        if (m) m.feedback = null;
      });
    }
    const onEvent = (event: AgentEvent) => emit({ type: 'team_member_event', memberId: member.id, event });

    // Light-model routing: a workstream whose steps are all tagged light
    // starts on the cheaper model — only on its first run; a resumed one
    // gets the full model. If the light run throws or leaves any of its
    // steps unfinished, the full model picks up the same conversation.
    const lightModel = lightModelFor(await getRoleModelConfig('coding'));
    const efforts = await planStepEfforts(latest);
    const light =
      lightModel && member.transcript.length === 0 && member.stepIds.every((id) => efforts.get(id) === 'light') ? lightModel : null;

    const common = { app, worktreePath, onEvent, restarted: restartedNow, abortSignal: signal };
    if (!light) {
      await runWorkstreamAgent({ ...common, session: latest, member, teammates: latest.codingTeam!.members });
      return;
    }
    await appendTeamTranscriptEntry(sessionId, member.id, { role: 'system', text: `Light workstream — running on ${light}.` });
    let failed = false;
    try {
      await runWorkstreamAgent({ ...common, session: latest, member, teammates: latest.codingTeam!.members, model: light });
    } catch {
      failed = true;
    }
    if (signal.aborted) return;
    const after = (await getSession(sessionId))!;
    const done = member.stepIds.every((id) => after.codingPlan?.find((s) => s.id === id)?.status === 'done');
    if (!failed && done) return;
    const { model } = await getRoleModelConfig('coding');
    await appendTeamTranscriptEntry(sessionId, member.id, {
      role: 'system',
      text: `↑ ${light} didn't finish this workstream — handing it to ${model}.`,
    });
    const again = after.codingTeam!.members.find((m) => m.id === member.id)!;
    await runWorkstreamAgent({
      ...common,
      restarted: false,
      session: after,
      member: again,
      teammates: after.codingTeam!.members,
      prompt:
        `A lighter model (${light}) worked on this workstream just now but didn't finish it cleanly. Review what ` +
        'it did in your checkout — commits and uncommitted changes — fix anything wrong or missing, then finish ' +
        'the remaining steps and leave nothing uncommitted.',
    });
  };

  // Leaves the branch clean and inside its owned paths for the lead to
  // review, or fails it with why. A run that errored (out of steps or
  // usage) still has its work committed, so the lead can judge what's there.
  const prepareForLead = async (member: CodingTeamMember, worktreePath: string, runError: string | null) => {
    // Checks and formatters can touch files the member doesn't own (lint
    // --fix, snapshots, a lockfile). Those belong to a teammate or nobody,
    // and would collide at merge, so they're thrown away, not committed.
    const stray = await uncommittedPathsOutside(worktreePath, member.ownedPaths);
    if (stray.length) {
      await discardPaths(worktreePath, stray);
      await appendTeamTranscriptEntry(sessionId, member.id, {
        role: 'system',
        text: `Discarded uncommitted changes outside this workstream's owned paths: ${stray.join(', ')}.`,
      });
    }
    if (await hasUncommittedChanges(worktreePath)) {
      await commitAll(worktreePath, `chore(${member.id}): commit remaining workstream changes`, member.ownedPaths);
    }
    const commits = await commitCount(worktreePath, sessionBranch, member.branch);
    if (runError) {
      await setStatus(member.id, 'failed', `${runError}${commits ? ` (${commits} commit${commits === 1 ? '' : 's'} on ${member.branch})` : ''}`);
      return;
    }
    if (commits === 0) {
      await setStatus(member.id, 'failed', 'Finished without committing anything — see its log.');
      return;
    }
    // git_commit can't commit outside the owned paths, so this only catches
    // a commit made some other way (a hook, a check command running git).
    const foreign = await committedPathsOutside(worktreePath, sessionBranch, member.branch, member.ownedPaths);
    if (foreign.length) {
      await setStatus(
        member.id,
        'failed',
        `Its commits change files outside its owned paths (${foreign.slice(0, 5).join(', ')}${foreign.length > 5 ? ', …' : ''}).`,
      );
      return;
    }
    await setStatus(member.id, 'ready', `${commits} commit${commits === 1 ? '' : 's'} on ${member.branch}, waiting for the lead.`);
  };

  // --- the lead ---------------------------------------------------------

  // A lead turn that errored (out of usage, no key) won't do better on the
  // next update, so the run stops handing him work and leaves it for the human.
  let leadBroken = false;
  const leadTurn = async (message: string) => {
    emit({ type: 'team_lead', active: true });
    try {
      const latest = (await getSession(sessionId))!;
      await runCodingAgentTurn(
        latest,
        message,
        (event) => {
          if (event.type === 'error' || (event.type === 'done' && event.isError)) leadBroken = true;
          emit({ type: 'team_member_event', memberId: LEAD_MEMBER_ID, event });
        },
        [],
        { teamLeadTurn: true },
      );
    } catch (err) {
      leadBroken = true;
      const message = err instanceof Error ? err.message : String(err);
      emit({ type: 'team_member_event', memberId: LEAD_MEMBER_ID, event: { type: 'error', message } });
    } finally {
      emit({ type: 'team_lead', active: false });
    }
  };

  const commitsAhead = async (members: CodingTeamMember[]) => {
    const ahead = new Map<string, number>();
    for (const m of members) {
      if (m.status !== 'ready' && m.status !== 'failed') continue;
      try {
        ahead.set(m.id, await commitCount(app.repoRoot, sessionBranch, m.branch));
      } catch {
        // its branch was never created
      }
    }
    return ahead;
  };

  // --- scheduling -------------------------------------------------------

  let poked = false;
  let waiter: (() => void) | null = null;
  const poke = () => {
    poked = true;
    waiter?.();
  };
  const nextPoke = () =>
    poked
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          waiter = resolve;
        });
  onTeamWake(sessionId, poke);

  const building = new Map<string, Promise<void>>();
  // Each building member's abort, for a restart; members being restarted;
  // and members whose next run is a restart (a fresh conversation with a handoff).
  const aborts = new Map<string, AbortController>();
  const restarting = new Set<string>();
  const restarted = new Set<string>();
  // Set the moment the loop below exits: no restart can be taken after it.
  let closed = false;

  // Back to waiting with a fresh conversation, for the scheduler to start
  // again. False if the lead decided on it meanwhile (merged, dropped).
  const resetForRestart = async (id: string, from: TeamMemberStatus[]): Promise<boolean> => {
    let reset = false;
    await mutateSession(sessionId, (s) => {
      const m = s.codingTeam?.members.find((x) => x.id === id);
      if (!m || !from.includes(m.status)) return;
      m.status = 'waiting';
      m.note = 'Restarted by you.';
      m.history = [];
      m.claudeSessionId = null;
      m.startedAt = null;
      m.finishedAt = null;
      reset = true;
    });
    if (reset) {
      restarted.add(id);
      emit({ type: 'team_member_status', memberId: id, status: 'waiting', note: 'Restarted by you.' });
    }
    return reset;
  };

  // The human's restart of one engineer: a running one is stopped (its work
  // so far stays in its checkout) and starts over; a failed one starts over
  // without waiting for the round to end. Either way it continues from a
  // handoff of what it did, not its old conversation.
  const restartMember = async (id: string): Promise<string | null> => {
    if (closed) return ROUND_FINISHING;
    const current = (await getSession(sessionId))!.codingTeam?.members.find((m) => m.id === id);
    if (!current) return `There is no workstream "${id}" in this round.`;
    if (closed) return ROUND_FINISHING;
    const abort = aborts.get(id);
    if (abort) {
      if (!restarting.has(id)) {
        restarting.add(id);
        abort.abort();
        await appendTeamTranscriptEntry(sessionId, id, { role: 'system', text: '⏹ Stopped by you — restarting.' });
      }
      return null;
    }
    if (building.has(id)) return null; // already restarting
    if (current.status !== 'failed') {
      return `${current.title} is ${current.status} — only a working or failed workstream can be restarted.`;
    }
    // Held in `building` so the loop can't finish the round mid-reset.
    building.set(
      id,
      (async () => {
        if (await resetForRestart(id, ['failed'])) {
          forLead.delete(id);
          await appendTeamTranscriptEntry(sessionId, id, { role: 'system', text: '⟲ Restarted by you.' });
        }
      })().finally(() => {
        building.delete(id);
        poke();
      }),
    );
    return null;
  };
  onMemberRestart('coding', sessionId, restartMember);
  // Members whose outcome the lead hasn't seen yet. A branch already ready
  // when the run (re)starts goes straight to him.
  const forLead = new Set(team.members.filter((m) => m.status === 'ready').map((m) => m.id));
  // A ready branch the lead didn't decide on gets one reminder.
  const reminded = new Set<string>();
  let lead: Promise<void> | null = null;

  for (;;) {
    poked = false;
    waiter = null;
    const members = (await getSession(sessionId))!.codingTeam!.members;

    for (const m of startable(members)) {
      if (building.has(m.id)) continue;
      const abort = new AbortController();
      aborts.set(m.id, abort);
      building.set(
        m.id,
        buildMember(m.id, abort.signal)
          .then(async () => {
            aborts.delete(m.id);
            if (!restarting.delete(m.id)) {
              forLead.add(m.id);
              return;
            }
            const reset = await resetForRestart(m.id, ['running', 'waiting', 'failed']).catch(() => false);
            if (!reset) forLead.add(m.id);
          })
          .finally(() => {
            building.delete(m.id);
            poke();
          }),
      );
    }

    if (!lead && !leadBroken && forLead.size > 0) {
      const ids = [...forLead];
      forLead.clear();
      const reminder = ids.every((id) => reminded.has(id))
        ? `You haven't merged, sent back or dropped ${ids.join(', ')} yet — decide now.\n\n`
        : '';
      const message = reminder + leadReviewMessage(members, ids, sessionBranch, await commitsAhead(members));
      lead = (async () => {
        await leadTurn(message);
        const after = (await getSession(sessionId))!.codingTeam!.members;
        for (const id of ids) {
          if (after.find((m) => m.id === id)?.status === 'ready' && !reminded.has(id)) {
            reminded.add(id);
            forLead.add(id);
          }
        }
      })().finally(() => {
        lead = null;
        poke();
      });
    }

    if (building.size === 0 && !lead && (forLead.size === 0 || leadBroken)) break;
    await nextPoke();
  }
  closed = true;

  // Whatever is still waiting can't start: what it depends on wasn't merged.
  const final = (await getSession(sessionId))!.codingTeam!.members;
  for (const m of final.filter((x) => x.status === 'waiting')) {
    const stuck = stuckDependencies(final, m);
    const unmerged = m.dependsOn.filter((d) => final.find((x) => x.id === d)?.status !== 'merged');
    await setStatus(
      m.id,
      'blocked',
      stuck.length ? `Waiting on ${stuck.join(', ')}, which didn't merge.` : `Waiting for the lead to merge ${unmerged.join(', ')}.`,
    );
  }
  const settled = (await getSession(sessionId))!.codingTeam!.members;
  const status = roundOutcome(settled);
  await mutateSession(sessionId, (s) => {
    if (s.codingTeam) {
      s.codingTeam.status = status;
      s.codingTeam.finishedAt = new Date().toISOString();
    }
    s.stage = 'coding-review';
  });
  emit({ type: 'team_status', status });

  // Everything merged: the lead checks the integrated branch as a whole.
  if (status === 'done' && !leadBroken && settled.some((m) => m.status === 'merged')) {
    await leadTurn(leadWrapUpMessage(settled, sessionBranch));
  }
}

/** At server start: any team marked running was cut off by the restart. */
export async function recoverInterruptedTeams(): Promise<void> {
  for (const session of await listSessions()) {
    if (session.codingTeam?.status !== 'running') continue;
    await mutateSession(session.id, (s) => {
      if (!s.codingTeam) return;
      s.codingTeam.status = 'interrupted';
      for (const m of s.codingTeam.members) {
        if (m.status === 'running' || m.status === 'waiting') {
          m.status = 'waiting';
          m.note = 'Interrupted when the agent server stopped — resume the team to continue.';
        } else if (m.status === 'merging') {
          // The merge aborts or completes atomically; the lead checks again.
          m.status = 'ready';
          m.note = 'Interrupted while merging — the lead will review it again.';
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
      if (member.status === 'merged' || member.status === 'dropped' || !repoRoot) continue;
      await withRepoLock(repoRoot, () => removeWorktree(repoRoot!, memberWorktree(session.id, team, member)));
    }
  }
  await fs.rm(worktreeDirFor(session.id), { recursive: true, force: true });
}
