import { getApp } from '../../apps/apps-store.js';
import { baseBranchFor } from '../../apps/apps.js';
import { appendTeamTranscriptEntry, getSession, listSessions, mutateSession } from '../../sessions/session-store.js';
import type { QaCheckCommand, QaReviewerStatus, QaTeamCheck, QaTeamMember } from '../../sessions/session.js';
import { createQaExecutors } from '../tool-defs/qa-tools.js';
import type { AgentEvent } from '../sdk-client.js';
import type { TeamEvent } from './coding-team.js';
import { runQaReviewerAgent } from './qa-reviewer-agent.js';

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

  const runMember = async (member: QaTeamMember): Promise<boolean> => {
    if (member.status === 'done') return true;
    try {
      if (member.transcript.length > 0) {
        await appendTeamTranscriptEntry(sessionId, member.id, { role: 'system', text: '⟲ Starting this review again.' }, 'qa');
      }
      await setStatus(member.id, 'running');
      const latest = (await getSession(sessionId))!;
      const fresh = latest.qaTeam!.members.find((m) => m.id === member.id)!;
      const onEvent = (event: AgentEvent) => emit({ type: 'team_member_event', memberId: member.id, event });
      await runQaReviewerAgent({ session: latest, app, member: fresh, teammates: latest.qaTeam!.members, onEvent });
      const after = (await getSession(sessionId))!.qaTeam?.members.find((m) => m.id === member.id);
      if (!after?.findings) {
        await setStatus(member.id, 'failed', 'Finished without submitting findings — see its log.');
        return false;
      }
      await setStatus(member.id, 'done');
      return true;
    } catch (err) {
      await setStatus(member.id, 'failed', err instanceof Error ? err.message : String(err));
      return false;
    }
  };

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

  const [results] = await Promise.all([Promise.all(team.members.map(runMember)), runChecks()]);
  const status = results.every(Boolean) ? 'done' : 'needs_attention';
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
