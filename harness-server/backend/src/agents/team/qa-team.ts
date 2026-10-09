import { getApp } from '../../apps/apps-store.js';
import { baseBranchFor } from '../../apps/apps.js';
import { appendTeamTranscriptEntry, getSession, listSessions, mutateSession } from '../../sessions/session-store.js';
import type { QaCheckCommand, QaReviewerStatus, QaTeamCheck } from '../../sessions/session.js';
import { createQaExecutors } from '../tool-defs/qa-tools.js';
import type { AgentEvent } from '../sdk-client.js';
import type { TeamEvent } from './coding-team.js';
import { runQaReviewerAgent } from './qa-reviewer-agent.js';
import { onMemberRestart, ROUND_FINISHING, untilAborted } from './team-state.js';

// Which sessions have a QA team run in flight in this process (see coding-team.ts).
const running = new Set<string>();

export function isQaTeamRunning(sessionId: string): boolean {
  return running.has(sessionId);
}

/**
 * Runs the review the QA lead split (assign_qa_team): every reviewer at
 * once, read-only, in the session's own checkout, with lint and the unit
 * tests running alongside them. Reviewers that didn't submit findings —
 * failed, or cut off by a restart — and checks that never finished are
 * picked up again by calling this again. The lead's next turn gets the
 * results (qa-agent.ts).
 */
export async function runQaTeam(sessionId: string, emit: (event: TeamEvent) => void): Promise<void> {
  if (running.has(sessionId)) throw new Error('The QA team is already running for this session.');
  running.add(sessionId);
  try {
    await run(sessionId, emit);
  } finally {
    running.delete(sessionId);
    onMemberRestart('qa', sessionId, null);
  }
}

async function run(sessionId: string, emit: (event: TeamEvent) => void): Promise<void> {
  const initial = await getSession(sessionId);
  if (!initial) throw new Error('Session not found.');
  if (!initial.branch || !initial.requirementsPath) throw new Error('QA needs a branch and an approved requirements document.');
  if (!initial.qaTeam) throw new Error("The QA lead hasn't split this review across a team.");
  const app = await getApp(initial.appId);

  const session = await mutateSession(sessionId, (s) => {
    const team = s.qaTeam!;
    team.status = 'running';
    team.finishedAt = null;
    team.relayed = false;
    for (const c of team.checks) if (c.status !== 'pass' && c.status !== 'fail') c.status = 'pending';
    // Everyone who hasn't submitted runs again, from a fresh conversation:
    // a reviewer's job is one read-through, not worth resuming.
    for (const m of team.members) {
      if (m.status === 'done') continue;
      m.status = 'waiting';
      m.note = null;
      m.startedAt = null;
      m.finishedAt = null;
      m.history = [];
      m.claudeSessionId = null;
      m.findings = null;
    }
  });
  const team = session.qaTeam!;
  emit({ type: 'team_status', status: 'running' });

  const setStatus = async (memberId: string, status: QaReviewerStatus, note: string | null = null) => {
    await mutateSession(sessionId, (s) => {
      const m = s.qaTeam?.members.find((x) => x.id === memberId);
      if (!m) return;
      m.status = status;
      m.note = note;
      if (status === 'running') m.startedAt = new Date().toISOString();
      if (status === 'done' || status === 'failed') m.finishedAt = new Date().toISOString();
    });
    emit({ type: 'team_member_status', memberId, status, note });
  };

  // A restart (restartMember below) aborts the reviewer's run; it's then
  // reset and started again instead of being marked failed.
  const runMember = async (memberId: string, signal: AbortSignal): Promise<void> => {
    try {
      const before = (await getSession(sessionId))!.qaTeam!.members.find((m) => m.id === memberId)!;
      if (before.status === 'done') return;
      if (before.transcript.length > 0) {
        await appendTeamTranscriptEntry(sessionId, memberId, { role: 'system', text: '⟲ Starting this review again.' }, 'qa');
      }
      await setStatus(memberId, 'running');
      const latest = (await getSession(sessionId))!;
      const fresh = latest.qaTeam!.members.find((m) => m.id === memberId)!;
      const onEvent = (event: AgentEvent) => emit({ type: 'team_member_event', memberId, event });
      await Promise.race([
        runQaReviewerAgent({ session: latest, app, member: fresh, teammates: latest.qaTeam!.members, onEvent, abortSignal: signal }),
        untilAborted(signal),
      ]);
      if (signal.aborted) return;
      const after = (await getSession(sessionId))!.qaTeam?.members.find((m) => m.id === memberId);
      if (!after?.findings) {
        await setStatus(memberId, 'failed', 'Finished without submitting findings — see its log.');
        return;
      }
      await setStatus(memberId, 'done');
    } catch (err) {
      if (signal.aborted) return;
      await setStatus(memberId, 'failed', err instanceof Error ? err.message : String(err));
    }
  };

  // Every reviewer's run in flight, and each one's abort for a restart.
  const inFlight = new Map<string, Promise<void>>();
  const aborts = new Map<string, AbortController>();
  const restarting = new Set<string>();
  // Set the moment the wait below ends: no restart can be taken after it.
  let closed = false;

  // Back to waiting with a fresh conversation. False if it isn't in one of `from`.
  const resetForRestart = async (id: string, from: QaReviewerStatus[]): Promise<boolean> => {
    let reset = false;
    await mutateSession(sessionId, (s) => {
      const m = s.qaTeam?.members.find((x) => x.id === id);
      if (!m || !from.includes(m.status)) return;
      Object.assign(m, { status: 'waiting', note: 'Restarted by you.', startedAt: null, finishedAt: null });
      Object.assign(m, { history: [], claudeSessionId: null, findings: null });
      reset = true;
    });
    if (reset) emit({ type: 'team_member_status', memberId: id, status: 'waiting', note: 'Restarted by you.' });
    return reset;
  };

  const launch = (id: string) => {
    const abort = new AbortController();
    aborts.set(id, abort);
    inFlight.set(
      id,
      runMember(id, abort.signal).then(async () => {
        aborts.delete(id);
        if (restarting.delete(id) && (await resetForRestart(id, ['running', 'waiting', 'failed']).catch(() => false))) {
          launch(id);
        } else {
          inFlight.delete(id);
        }
      }),
    );
  };

  // The human's restart of one reviewer: a running one is stopped and
  // reviews again from scratch; a failed one runs again straight away.
  const restartMember = async (id: string): Promise<string | null> => {
    if (closed) return ROUND_FINISHING;
    const current = (await getSession(sessionId))!.qaTeam?.members.find((m) => m.id === id);
    if (!current) return `There is no reviewer "${id}" in this round.`;
    if (closed) return ROUND_FINISHING;
    const abort = aborts.get(id);
    if (abort) {
      if (!restarting.has(id)) {
        restarting.add(id);
        abort.abort();
        await appendTeamTranscriptEntry(sessionId, id, { role: 'system', text: '⏹ Stopped by you — restarting.' }, 'qa');
      }
      return null;
    }
    if (inFlight.has(id)) return null; // already restarting
    if (current.status !== 'failed') return `${current.title} is ${current.status} — only a working or failed reviewer can be restarted.`;
    // Held in inFlight so the round can't end mid-reset.
    inFlight.set(
      id,
      resetForRestart(id, ['failed']).then((reset) => {
        if (reset) launch(id);
        else inFlight.delete(id);
      }),
    );
    return null;
  };
  onMemberRestart('qa', sessionId, restartMember);

  // The checks share the checkout's junit.xml, so they run one after the
  // other — alongside the reviewers, which only read.
  const { runCheckedCommandExecute } = createQaExecutors({
    repoRoot: app.repoRoot,
    baseBranch: baseBranchFor(app),
    checkCommands: app.checkCommands,
    // The runner helper may shorten a failing log; it's logged, but has no
    // chat of its own to show up in.
    helperContext: { sessionId, stage: 'qa', record: async () => {} },
  });
  const setCheck = async (command: QaCheckCommand, status: QaTeamCheck['status'], output: string | null = null) => {
    await mutateSession(sessionId, (s) => {
      const c = s.qaTeam?.checks.find((x) => x.command === command);
      if (c) Object.assign(c, { status, output });
    });
    emit({ type: 'team_check', command, status });
  };
  const runChecks = async () => {
    for (const check of team.checks) {
      if (check.status === 'pass' || check.status === 'fail') continue;
      await setCheck(check.command, 'running');
      try {
        const output = await runCheckedCommandExecute({ command: check.command });
        await setCheck(check.command, output.split('\n')[0].includes('succeeded') ? 'pass' : 'fail', output);
      } catch (err) {
        await setCheck(check.command, 'fail', err instanceof Error ? err.message : String(err));
      }
    }
  };

  for (const m of team.members) launch(m.id);
  let checksDone = false;
  const checks = runChecks().finally(() => {
    checksDone = true;
  });
  // A restart can add a run while others are going, so this waits until
  // nothing is in flight rather than on a fixed list. Only unsettled work
  // goes in the race: a finished `checks` would resolve every race at once
  // and spin here without yielding until the heap ran out.
  for (;;) {
    const pending = [...inFlight.values()];
    if (!checksDone) pending.push(checks);
    if (pending.length === 0) break;
    await Promise.race(pending);
  }
  closed = true;
  const settled = (await getSession(sessionId))!.qaTeam!.members;
  const status = settled.every((m) => m.status === 'done') ? 'done' : 'needs_attention';
  await mutateSession(sessionId, (s) => {
    if (s.qaTeam) {
      s.qaTeam.status = status;
      s.qaTeam.finishedAt = new Date().toISOString();
    }
  });
  emit({ type: 'team_status', status });
}

/** At server start: any QA team marked running was cut off by the restart. */
export async function recoverInterruptedQaTeams(): Promise<void> {
  for (const session of await listSessions()) {
    if (session.qaTeam?.status !== 'running') continue;
    await mutateSession(session.id, (s) => {
      if (!s.qaTeam) return;
      s.qaTeam.status = 'interrupted';
      for (const c of s.qaTeam.checks) if (c.status === 'running') c.status = 'pending';
      for (const m of s.qaTeam.members) {
        if (m.status === 'running' || m.status === 'waiting') {
          m.status = 'waiting';
          m.note = 'Interrupted when the agent server stopped — resume the team to continue.';
        }
      }
    });
  }
}
