import { useEffect, useRef, useState } from 'react';
import { COORDINATOR_PERSONA } from './agents';
import { useQueryClient } from '@tanstack/react-query';
import { postSSE } from './sse-client';
import type { AgentEvent, AttachmentInput, TranscriptEntry } from './types';

/**
 * How a send() turn ended: a stream/network error, and the last `done` event
 * (a turn can emit several — continuation rounds, a light-model escalation —
 * and the last one is how it finished). Used by auto-run to tell a turn that
 * can't go on (out of tokens, usage limit) from a finished one.
 */
export interface TurnOutcome {
  error: string | null;
  lastDone: { text: string; isError: boolean } | null;
}

// Queries a turn changes as it goes (the server saves each entry, plan step and
// commit as it happens), so they're refetched mid-turn rather than only at the end.
const LIVE_QUERIES = new Set(['session', 'coding-diff', 'plan-doc', 'requirements-doc', 'qa-report', 'qa-loop']);
const LIVE_REFRESH_MS = 1500;

let overlaySeq = 0;
function nextId() {
  overlaySeq += 1;
  return `overlay-${overlaySeq}`;
}

/**
 * Shared streaming-turn logic for the three agent stages: optimistically
 * render the user's message plus each streamed event, then hand off to the
 * caller (which refetches the persisted session/transcript) once done.
 * `runningTool` tracks the most recent tool_call that hasn't been resolved
 * by a tool_result yet, for a live "agent is doing X right now" indicator —
 * it's a UI nicety assuming roughly sequential tool calls, not a precise
 * per-call correlation.
 */
export function useAgentTurnStream() {
  const [overlay, setOverlay] = useState<TranscriptEntry[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [runningTool, setRunningTool] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // When the running turn began: persisted entries from before it are shown,
  // later ones come from the overlay (they'd otherwise appear twice once a
  // mid-turn refetch picks them up).
  const [turnStartedAt, setTurnStartedAt] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const lastLiveRefresh = useRef(0);
  const refreshLive = () => {
    const now = Date.now();
    if (now - lastLiveRefresh.current < LIVE_REFRESH_MS) return;
    lastLiveRefresh.current = now;
    void queryClient.invalidateQueries({ predicate: (q) => LIVE_QUERIES.has(String(q.queryKey[0])) });
  };
  // Each call's tool, so a result can be shown for its tool (the delegate card).
  const toolNames = useRef(new Map<string, string>());
  // Aborted when the component unmounts (tab switch / navigation) so the
  // in-flight SSE stream is released — the server-side agent keeps running.
  const abortCtrl = useRef<AbortController | null>(null);
  useEffect(() => () => { abortCtrl.current?.abort(); }, []);

  const consume = (onEvent?: (event: AgentEvent) => void) => (event: AgentEvent) => {
    onEvent?.(event);
    if (event.type === 'tool_result' || event.type === 'compacted') refreshLive();
    if (event.type === 'assistant_text') {
      setOverlay((prev) => [...prev, { id: nextId(), role: 'assistant', text: event.text, timestamp: new Date().toISOString() }]);
    } else if (event.type === 'tool_call') {
      setRunningTool(event.name);
      toolNames.current.set(event.toolCallId, event.name);
      setOverlay((prev) => [
        ...prev,
        {
          id: nextId(),
          role: 'tool_call',
          toolCallId: event.toolCallId,
          toolName: event.name,
          toolInput: event.input,
          timestamp: new Date().toISOString(),
        },
      ]);
    } else if (event.type === 'tool_result') {
      setRunningTool(null);
      setOverlay((prev) => [
        ...prev,
        {
          id: nextId(),
          role: 'tool_result',
          toolCallId: event.toolCallId,
          toolName: toolNames.current.get(event.toolCallId),
          toolResult: event.content,
          isError: event.isError,
          timestamp: new Date().toISOString(),
        },
      ]);
    } else if (event.type === 'coordinator_decision') {
      setOverlay((prev) => [
        ...prev,
        {
          id: nextId(),
          role: 'system',
          text: `${COORDINATOR_PERSONA.name}: ${
            event.action === 'continue' ? 'continuing' : event.action === 'advanced' ? 'approved' : 'stopped for you'
          } — ${event.reason}`,
          timestamp: new Date().toISOString(),
        },
      ]);
    } else if (event.type === 'continuation') {
      setOverlay((prev) => [
        ...prev,
        {
          id: nextId(),
          role: 'system',
          text: `↻ Turn budget reached — continuing automatically (round ${event.hop} of ${event.maxHops}).`,
          timestamp: new Date().toISOString(),
        },
      ]);
    } else if (event.type === 'compacted') {
      setOverlay((prev) => [
        ...prev,
        {
          id: nextId(),
          role: 'system',
          text: `⟲ New conversation — this one reached ${Math.round(event.contextTokens / 1000)}k tokens, so it continues from a handoff note.`,
          timestamp: new Date().toISOString(),
        },
      ]);
    } else if (event.type === 'error') {
      setError(event.message);
    }
  };

  const send = async (
    url: string,
    message: string,
    onDone: () => void | Promise<unknown>,
    onEvent?: (event: AgentEvent) => void,
    attachments?: AttachmentInput[],
    extraBody?: Record<string, unknown>
  ): Promise<TurnOutcome> => {
    const outcome: TurnOutcome = { error: null, lastDone: null };
    const track = (event: AgentEvent) => {
      if (event.type === 'done') outcome.lastDone = { text: event.text, isError: event.isError };
      else if (event.type === 'error') outcome.error = event.message;
      onEvent?.(event);
    };
    const ctrl = new AbortController();
    abortCtrl.current = ctrl;
    setError(null);
    setStreaming(true);
    setTurnStartedAt(new Date().toISOString());
    setRunningTool(null);
    setOverlay([{ id: nextId(), role: 'user', text: message, timestamp: new Date().toISOString() }]);

    try {
      await postSSE(url, { message, ...(attachments?.length ? { attachments } : {}), ...extraBody }, consume(track), ctrl.signal);
    } catch (err) {
      if (!ctrl.signal.aborted) {
        outcome.error = err instanceof Error ? err.message : String(err);
        setError(outcome.error);
      }
    } finally {
      if (!ctrl.signal.aborted) {
        // The server saves a message's attachments as the session's reference docs.
        if (attachments?.length) void queryClient.invalidateQueries({ queryKey: ['reference-docs'] });
        // Keep the overlay up until the refetch lands, or the turn's last
        // entries vanish for a moment before the saved ones arrive.
        await Promise.resolve(onDone()).catch(() => {});
      }
      setStreaming(false);
      setRunningTool(null);
      setOverlay([]);
    }
    return outcome;
  };

  // Drives /coordinator/run — unlike send(), there's no single human-typed
  // message (the coordinator composes its own, possibly several in one
  // stream), so there's nothing to optimistically prepend; each underlying
  // turn's own message still lands in the persisted transcript once that
  // turn's run*AgentTurn function appends it, picked up on the next
  // session refetch via onDone/onEvent.
  const runCoordinator = async (sessionId: string, onDone: () => void | Promise<unknown>, onEvent?: (event: AgentEvent) => void) => {
    const ctrl = new AbortController();
    abortCtrl.current = ctrl;
    setError(null);
    setStreaming(true);
    setTurnStartedAt(new Date().toISOString());
    setRunningTool(null);
    setOverlay([]);

    try {
      await postSSE(`/api/sessions/${sessionId}/coordinator/run`, {}, consume(onEvent), ctrl.signal);
    } catch (err) {
      if (!ctrl.signal.aborted) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!ctrl.signal.aborted) await Promise.resolve(onDone()).catch(() => {});
      setStreaming(false);
      setRunningTool(null);
      setOverlay([]);
    }
  };

  /** The stage's transcript with the running turn's live entries in place of its saved ones. */
  const withOverlay = (persisted: TranscriptEntry[]) =>
    streaming ? [...persisted.filter((e) => !turnStartedAt || e.timestamp < turnStartedAt), ...overlay] : persisted;

  return { overlay, streaming, runningTool, error, send, runCoordinator, withOverlay };
}
