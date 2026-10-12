'use client';

import { useEffect } from 'react';
import { COORDINATOR_PERSONA } from './agents';
import { stageGroupFor, type StageGroup } from './stage';
import type { SessionRecord } from './types';

// Runs that already started, by what they were started for, so a refetch
// or remount doesn't start the same one twice.
const started = new Set<string>();

/**
 * Starts Bridget (/coordinator/run) on the live stage whenever there's
 * something she hasn't handled yet: a stage with nothing said yet (she
 * kicks it off), an agent turn the human started, or a QA rerun after fixes.
 * Her own note last in the chat means she already stopped there for the
 * human, so she isn't restarted on the same state, which also keeps a
 * persistent error from looping. The server drives the stage until she
 * approves it or something needs the human (routes/coordinator.ts).
 */
export function useCoordinatorAutoRun(params: {
  session: SessionRecord;
  group: StageGroup;
  streaming: boolean;
  runCoordinator: (sessionId: string, onDone: () => void) => Promise<void>;
  refresh: () => void;
  // Something else this tab starts first (e.g. a meeting kickoff).
  blocked?: boolean;
}) {
  const { session, group, streaming, runCoordinator, refresh, blocked } = params;
  const live = stageGroupFor(session) === group;
  const transcript = session.transcripts[group];
  const last = transcript.at(-1);
  const bridgetSpokeLast = last?.role === 'system' && Boolean(last.text?.startsWith(`${COORDINATOR_PERSONA.name}:`));
  const rerun = group === 'qa' && session.qaRerunPending;
  const key = `${session.id}:${group}:${session.stage}:${last?.id ?? 'empty'}:${rerun}`;

  useEffect(() => {
    if (!session.coordinatorEnabled || streaming || !live || blocked) return;
    if (bridgetSpokeLast && !rerun) return;
    // Requirements can't start from nothing: the human describes the feature.
    if (group === 'requirements' && transcript.length === 0) return;
    if (started.has(key)) return;
    started.add(key);
    void runCoordinator(session.id, refresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, session.coordinatorEnabled, streaming, live, blocked]);
}
