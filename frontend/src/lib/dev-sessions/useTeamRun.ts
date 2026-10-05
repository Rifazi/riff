import { useState } from 'react';
import { postSSE } from './sse-client';
import type { TeamEvent, TranscriptEntry } from './types';

let seq = 0;
const nextId = () => `overlay-team-${++seq}`;

/**
 * Drives /coding/team/run: one SSE stream carrying every team member's
 * events, tagged by memberId. Keeps a live overlay and "running tool" per
 * member (the persisted transcripts arrive with the next session refetch),
 * mirroring what useAgentTurnStream does for a single agent.
 */
export function useTeamRun() {
  const [running, setRunning] = useState(false);
  const [overlays, setOverlays] = useState<Record<string, TranscriptEntry[]>>({});
  const [runningTools, setRunningTools] = useState<Record<string, string | null>>({});
  const [error, setError] = useState<string | null>(null);
  // Persisted transcript entries from this run are also in the overlay —
  // lanes show persisted entries from before this instant plus the overlay.
  const [startedAt, setStartedAt] = useState<string | null>(null);

  const push = (memberId: string, entry: Omit<TranscriptEntry, 'id' | 'timestamp'>) =>
    setOverlays((prev) => ({
      ...prev,
      [memberId]: [...(prev[memberId] ?? []), { ...entry, id: nextId(), timestamp: new Date().toISOString() }],
    }));

  const start = async (sessionId: string, onChange: () => void) => {
    setError(null);
    setRunning(true);
    setStartedAt(new Date().toISOString());
    setOverlays({});
    setRunningTools({});
    try {
      // Each call's tool, so a result can be shown for its tool (the delegate card).
      const toolNames = new Map<string, string>();
      await postSSE<TeamEvent>(`/api/sessions/${sessionId}/coding/team/run`, {}, (e) => {
        if (e.type === 'error') {
          setError(e.message);
        } else if (e.type === 'team_member_status' || e.type === 'team_status') {
          // Persisted server-side — refetch for the new status.
          if (e.type === 'team_member_status' && e.status !== 'running') {
            setRunningTools((prev) => ({ ...prev, [e.memberId]: null }));
          }
          onChange();
        } else if (e.type === 'team_member_event') {
          const { memberId, event } = e;
          if (event.type === 'assistant_text') push(memberId, { role: 'assistant', text: event.text });
          else if (event.type === 'tool_call') {
            setRunningTools((prev) => ({ ...prev, [memberId]: event.name }));
            toolNames.set(event.toolCallId, event.name);
            push(memberId, { role: 'tool_call', toolName: event.name, toolInput: event.input });
          } else if (event.type === 'tool_result') {
            setRunningTools((prev) => ({ ...prev, [memberId]: null }));
            push(memberId, {
              role: 'tool_result',
              toolName: toolNames.get(event.toolCallId),
              toolResult: event.content,
              isError: event.isError,
            });
            // Checklist ticks, commits and the diff land as tools finish.
            onChange();
          } else if (event.type === 'error') {
            push(memberId, { role: 'system', text: event.message, isError: true });
          }
        }
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
      setStartedAt(null);
      setRunningTools({});
      setOverlays({});
      onChange();
    }
  };

  return { running, overlays, runningTools, error, startedAt, start };
}
