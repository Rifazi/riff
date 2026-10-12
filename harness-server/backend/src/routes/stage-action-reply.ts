import type { FastifyReply } from 'fastify';
import { StageActionError } from '../sessions/stage-actions.js';

/** A stage action's refusal as the route's error reply (anything else is a 400 with its message). */
export function sendStageActionError(reply: FastifyReply, err: unknown) {
  if (err instanceof StageActionError) return reply.code(err.status).send({ error: err.message, ...err.extra });
  return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
}
