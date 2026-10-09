import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { useTeamRun, type TeamKind } from './useTeamRun';
import type { CodingTeamState, TranscriptEntry } from './types';

// Which round of which team was last started per session — module-level so
// a tab-switch remount doesn't start the same round twice. Keyed by round and
// startedAt: the coding lead re-queues a round (new startedAt) when he merges
// or sends back a branch outside a run.
const startedRounds = new Map<string, string>();

/** The query key for a team's "is a run going server-side" check; stage refreshes invalidate it. */
export const teamStatusKey = (kind: TeamKind, sessionId: string) => ['team-status', kind, sessionId];

/**
 * Drives a stage's team on the shared team board (components/DevSessions/
 * AgentTeam.tsx): runs it, starts an assigned round once the lead's turn
 * has ended, polls a run started elsewhere, and works out the board's
 * status. Used by the Coding tab (Jack's engineers) and the QA tab (Tess's
 * reviewers).
 */
export function useTeamBoard<M extends { id: string; transcript: TranscriptEntry[] }>({
  sessionId,
  kind,
  team,
  leadBusy,
  refresh,
}: {
  sessionId: string;
  kind: TeamKind;
  team: { status: CodingTeamState['status']; round: number; startedAt?: string; members: M[] } | null;
  /** The lead is mid-turn: an assigned round waits for it to end. */
  leadBusy: boolean;
  refresh: () => void;
}) {
  const run = useTeamRun(kind);
  // A run keeps going server-side if this page is closed; the persisted
  // status alone can't tell that apart from a run cut off by a restart.
  const { data: server } = useQuery({
    queryKey: teamStatusKey(kind, sessionId),
    queryFn: () => api.getTeamStatus(sessionId, kind),
    enabled: Boolean(team),
  });
  const active = run.running || (team?.status === 'running' && server?.running !== false);
  const status =
    !team || team.status === 'assigned'
      ? ('not_started' as const)
      : team.status === 'running' && !active
        ? ('interrupted' as const)
        : team.status;
  const finished = Boolean(team) && !active && (status === 'done' || status === 'needs_attention');

  // Watching a run started elsewhere (another window, or before a reload):
  // poll instead of streaming. Not once the server says no run is going: a
  // run cut off by a restart stays "running" on disk and would otherwise be
  // polled forever.
  useEffect(() => {
    if (run.running || !active) return;
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.running, active]);

  const start = () => void run.start(sessionId, refresh);

  // Restarting one member: inside a live run the server stops it (if it's
  // working) and starts it over; with no run going, resuming the team
  // reruns it along with anything else that didn't finish.
  const [restarting, setRestarting] = useState<string | null>(null);
  const [restartError, setRestartError] = useState<string | null>(null);
  const restartMember = async (memberId: string) => {
    setRestarting(memberId);
    setRestartError(null);
    try {
      if (active) {
        const { live } = await api.restartTeamMember(sessionId, kind, memberId);
        if (live) {
          refresh();
          return;
        }
      }
      if (!run.running) start();
    } catch (err) {
      setRestartError(err instanceof Error ? err.message : String(err));
    } finally {
      setRestarting(null);
    }
  };

  // The lead assigned a team: start it once the lead's turn has ended, once per round.
  useEffect(() => {
    if (team?.status !== 'assigned' || run.running || leadBusy) return;
    const key = `${kind}:${sessionId}`;
    const marker = `${team.round}:${team.startedAt ?? ''}`;
    if (startedRounds.get(key) === marker) return;
    startedRounds.set(key, marker);
    start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [team?.status, team?.round, team?.startedAt, run.running, leadBusy]);

  const entriesFor = (member: M) =>
    run.running && run.startedAt
      ? [...member.transcript.filter((e) => e.timestamp < run.startedAt!), ...(run.overlays[member.id] ?? [])]
      : member.transcript;

  return { run, active, status, finished, start, entriesFor, restartMember, restarting, restartError };
}
