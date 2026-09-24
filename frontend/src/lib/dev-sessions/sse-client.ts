import type { AgentEvent } from './types';
import { apiUrl } from './api';

/**
 * The agent-turn endpoints are POST (they take a message body), so the
 * browser's native EventSource (GET-only) can't be used. This parses the
 * same "data: ...\n\n" SSE framing manually off a streamed fetch response.
 */
export async function postSSE(
  path: string,
  body: unknown,
  onEvent: (event: AgentEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(apiUrl(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    // WebKit reports every network-level failure as a bare "Load failed".
    throw new Error("Couldn't reach the agent server — it may have stopped or restarted. Check the banner above, then try again.");
  }

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    let message = text;
    try {
      message = (JSON.parse(text) as { error?: string }).error ?? text;
    } catch {
      // not JSON — show as-is
    }
    throw new Error(`The agent server rejected this (${res.status}): ${message}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    let chunk: Awaited<ReturnType<typeof reader.read>>;
    try {
      chunk = await reader.read();
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new Error('Lost the connection to the agent server mid-reply. Its work so far is saved — reload the session to see it.');
    }
    const { done, value } = chunk;
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const chunks = buffer.split('\n\n');
    buffer = chunks.pop() ?? '';

    for (const chunk of chunks) {
      const line = chunk.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;
      try {
        const event = JSON.parse(line.slice('data: '.length)) as AgentEvent;
        onEvent(event);
      } catch {
        // ignore malformed frame
      }
    }
  }
}
