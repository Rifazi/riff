import type { OutgoingHttpHeaders } from 'node:http';
import type { FastifyReply } from 'fastify';

/**
 * Starts a Server-Sent Events response on a hijacked reply. Writing the raw
 * head directly would drop headers Fastify hooks already queued on the reply
 * — notably @fastify/cors's Access-Control-Allow-Origin, without which the
 * Meetily webview (a different origin) rejects the stream with "Load failed".
 */
export function startEventStream(reply: FastifyReply): void {
  reply.raw.writeHead(200, {
    ...(reply.getHeaders() as OutgoingHttpHeaders),
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  reply.hijack();
}
