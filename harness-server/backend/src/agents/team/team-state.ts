import path from 'node:path';
import { config } from '../../config.js';
import type { CodingTeamMember, CodingTeamState } from '../../sessions/session.js';

// Shared by the team runner (coding-team.ts) and the lead's team tools
// (tool-defs/team-lead-tools.ts), which can't import the runner without a
// cycle through coding-agent.ts.

// Which sessions have a team run in flight in this process — the persisted
// status alone can't tell a live run from one the server was killed during.
export const runningTeams = new Set<string>();

export function isTeamRunning(sessionId: string): boolean {
  return runningTeams.has(sessionId);
}

export function worktreeDirFor(sessionId: string, memberId?: string): string {
  const dir = path.join(config.stateDir, 'worktrees', sessionId);
  return memberId ? path.join(dir, memberId) : dir;
}

// A member's branch suffix and worktree name. Round 1 keeps the bare id (as
// before rounds existed); later rounds are prefixed so an earlier round's
// unmerged branch or worktree never collides with the new one.
export function memberKey(team: Pick<CodingTeamState, 'round'>, member: Pick<CodingTeamMember, 'id'>): string {
  return team.round > 1 ? `r${team.round}-${member.id}` : member.id;
}

export function memberWorktree(sessionId: string, team: Pick<CodingTeamState, 'round'>, member: Pick<CodingTeamMember, 'id'>): string {
  return worktreeDirFor(sessionId, memberKey(team, member));
}

// A running team's scheduler, so the lead's merge or send-back starts the
// workstreams it unblocks straight away, mid-turn, instead of after it.
const wakers = new Map<string, () => void>();

export function onTeamWake(sessionId: string, wake: (() => void) | null): void {
  if (wake) wakers.set(sessionId, wake);
  else wakers.delete(sessionId);
}

export function wakeTeam(sessionId: string): void {
  wakers.get(sessionId)?.();
}

// A running team's member restart, so the human can restart one engineer or
// reviewer that failed or stalled without waiting for the round to end.
// Keyed by team kind and session; each runner registers its own for the
// length of its run. The handler returns why it can't, or null.
type RestartHandler = (memberId: string) => Promise<string | null>;
const restarters = new Map<string, RestartHandler>();

export function onMemberRestart(kind: 'coding' | 'qa', sessionId: string, handler: RestartHandler | null): void {
  if (handler) restarters.set(`${kind}:${sessionId}`, handler);
  else restarters.delete(`${kind}:${sessionId}`);
}

/**
 * Restarts a member inside the team's live run. `live: false` means no run
 * is going in this process: resuming the team reruns every member that
 * didn't finish, this one included.
 */
export async function restartLiveMember(
  kind: 'coding' | 'qa',
  sessionId: string,
  memberId: string,
): Promise<{ live: boolean; error: string | null }> {
  const handler = restarters.get(`${kind}:${sessionId}`);
  if (!handler) return { live: false, error: null };
  return { live: true, error: await handler(memberId) };
}

// The run loops can't exit while a restart is in flight, but once a round is
// past its last member it's wrapping up and can't take one.
export const ROUND_FINISHING = 'This round is finishing — restart the member once it has.';

/** Resolves when the signal aborts: raced against a member's run, so a hung tool can't hold up a restart. */
export function untilAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
}
