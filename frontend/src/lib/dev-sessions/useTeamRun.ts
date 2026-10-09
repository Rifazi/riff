import { useState } from 'react';
import { postSSE } from './sse-client';
import type { TeamEvent, TranscriptEntry } from './types';

/** Which team a run drives: the coding team or the QA team. */
export type TeamKind = 'coding' | 'qa';

let seq = 0;
const nextId = () => `overlay-team-${++seq}`;

// The coding lead's turns during a run (harness-server LEAD_MEMBER_ID): he
// reviews and merges branches mid-run. His chat is the stage's own
// transcript, so it's refetched as he goes instead of overlaid.
const LEAD_ID = 'lead';
// His tools whose result changes what the board shows.
const LEAD_STATE_TOOLS = /(merge_workstream|send_back_workstream|drop_workstreams|write_coding_plan|git_commit)$/;

/**
 * Drives /coding/team/run or /qa/team/run: one SSE stream carrying every team member's
 * events, tagged by memberId. Keeps a live overlay and "running tool" per
 * member (the persisted transcripts arrive with the next session refetch),
 * mirroring what useAgentTurnStream does for a single agent.
 */
export function useTeamRun(kind: TeamKind = 'coding') {
  const [running, setRunning] = useState(false);
  const [overlays, setOverlays] = useState<Record<string, TranscriptEntry[]>>({});
  const [runningTools, setRunningTools] = useState<Record<string, string | null>>({});
  const [error, setError] = useState<string | null>(null);
  const [leadActive, setLeadActive] = useState(false);
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
      await postSSE<TeamEvent>(`/api/sessions/${sessionId}/${kind}/team/run`, {}, (e) => {
        if (e.type === 'error') {
          setError(e.message);
        } else if (e.type === 'team_lead') {
          setLeadActive(e.active);
          if (!e.active) setRunningTools((prev) => ({ ...prev, [LEAD_ID]: null }));
          onChange();
        } else if (e.type === 'team_member_event' && e.memberId === LEAD_ID) {
          const { event } = e;
          if (event.type === 'tool_call') {
            setRunningTools((prev) => ({ ...prev, [LEAD_ID]: event.name }));
            toolNames.set(event.toolCallId, event.name);
          } else if (event.type === 'tool_result') {
            setRunningTools((prev) => ({ ...prev, [LEAD_ID]: null }));
            if (LEAD_STATE_TOOLS.test(toolNames.get(event.toolCallId) ?? '')) onChange();
          } else if (event.type === 'assistant_text') {
            onChange();
          } else if (event.type === 'error') {
            setError(event.message);
          }
        } else if (e.type === 'team_member_status' || e.type === 'team_status' || e.type === 'team_check') {
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
      setLeadActive(false);
      setStartedAt(null);
      setRunningTools({});
      setOverlays({});
      onChange();
    }
  };

  return { running, overlays, runningTools, error, startedAt, leadActive, start };
}
