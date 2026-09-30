import { useState } from 'react';
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
  const queryClient = useQueryClient();

  const consume = (onEvent?: (event: AgentEvent) => void) => (event: AgentEvent) => {
    onEvent?.(event);
    if (event.type === 'assistant_text') {
      setOverlay((prev) => [...prev, { id: nextId(), role: 'assistant', text: event.text, timestamp: new Date().toISOString() }]);
    } else if (event.type === 'tool_call') {
      setRunningTool(event.name);
      setOverlay((prev) => [
        ...prev,
        { id: nextId(), role: 'tool_call', toolName: event.name, toolInput: event.input, timestamp: new Date().toISOString() },
      ]);
    } else if (event.type === 'tool_result') {
      setRunningTool(null);
      setOverlay((prev) => [
        ...prev,
        { id: nextId(), role: 'tool_result', toolResult: event.content, isError: event.isError, timestamp: new Date().toISOString() },
      ]);
    } else if (event.type === 'coordinator_decision') {
      setOverlay((prev) => [
        ...prev,
        {
          id: nextId(),
          role: 'system',
          text: `Coordinator: ${event.action === 'continue' ? 'continuing' : 'ready for review'} — ${event.reason}`,
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
    } else if (event.type === 'error') {
      setError(event.message);
    }
  };

  const send = async (
    url: string,
    message: string,
    onDone: () => void,
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
    setError(null);
    setStreaming(true);
    setRunningTool(null);
    setOverlay([{ id: nextId(), role: 'user', text: message, timestamp: new Date().toISOString() }]);

    try {
      await postSSE(url, { message, ...(attachments?.length ? { attachments } : {}), ...extraBody }, consume(track));
    } catch (err) {
      outcome.error = err instanceof Error ? err.message : String(err);
      setError(outcome.error);
    } finally {
      setStreaming(false);
      setRunningTool(null);
      setOverlay([]);
      // The server saves a message's attachments as the session's reference docs.
      if (attachments?.length) void queryClient.invalidateQueries({ queryKey: ['reference-docs'] });
      onDone();
    }
    return outcome;
  };

  // Drives /coordinator/run — unlike send(), there's no single human-typed
  // message (the coordinator composes its own, possibly several in one
  // stream), so there's nothing to optimistically prepend; each underlying
  // turn's own message still lands in the persisted transcript once that
  // turn's run*AgentTurn function appends it, picked up on the next
  // session refetch via onDone/onEvent.
  const runCoordinator = async (sessionId: string, onDone: () => void, onEvent?: (event: AgentEvent) => void) => {
    setError(null);
    setStreaming(true);
    setRunningTool(null);
    setOverlay([]);

    try {
      await postSSE(`/api/sessions/${sessionId}/coordinator/run`, {}, consume(onEvent));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStreaming(false);
      setRunningTool(null);
      setOverlay([]);
      onDone();
    }
  };

  return { overlay, streaming, runningTool, error, send, runCoordinator };
}
