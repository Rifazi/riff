import type { FastifyInstance } from 'fastify';
import { startEventStream } from '../routes/sse.js';

/**
 * Things the human should hear about even with Riff in the background: a task
 * finished, or an agent stopped and is waiting on them. The server only says
 * so; the app turns it into a macOS notification (it owns the permission and
 * the user's notification settings).
 */
export interface AttentionEvent {
  kind: 'done' | 'attention';
  sessionId: string;
  title: string;
  body: string;
}

type Listener = (event: AttentionEvent) => void;
const listeners = new Set<Listener>();
// The same stop is often reached again (a rerun on the same stage); say it once.
const lastBySession = new Map<string, string>();

export function notifyAttention(event: AttentionEvent): void {
  const key = `${event.kind}:${event.body}`;
  if (lastBySession.get(event.sessionId) === key) return;
  lastBySession.set(event.sessionId, key);
  for (const listener of listeners) listener(event);
}

/** Forget what was last said, so a session that moved on can be told about again. */
export function resetAttention(sessionId: string): void {
  lastBySession.delete(sessionId);
}

export async function registerAttentionRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/notifications/stream', async (request, reply) => {
    startEventStream(reply);
    const write = (chunk: string) => {
      if (!reply.raw.writableEnded) reply.raw.write(chunk);
    };
    const listener: Listener = (event) => write(`data: ${JSON.stringify(event)}\n\n`);
    listeners.add(listener);
    write(': connected\n\n');
    const heartbeat = setInterval(() => write(': ping\n\n'), 25_000);
    request.raw.on('close', () => {
      clearInterval(heartbeat);
      listeners.delete(listener);
    });
  });
}
