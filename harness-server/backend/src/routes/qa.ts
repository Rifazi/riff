import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { startEventStream } from './sse.js';
import { config } from '../config.js';
import { getSession, updateSession } from '../sessions/session-store.js';
import { runQaAgentTurn } from '../agents/qa-agent.js';
import { parseAttachments, type AttachmentInput } from '../agents/attachments.js';
import type { AgentEvent } from '../agents/sdk-client.js';

export async function registerQaRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { id: string }; Body: { message: string; attachments?: AttachmentInput[] } }>(
    '/api/sessions/:id/qa/message',
    async (request, reply) => {
      const session = await getSession(request.params.id);
      if (!session) return reply.code(404).send({ error: 'session not found' });
      if (!session.branch) {
        return reply.code(400).send({ error: 'coding must be approved (a branch must exist) before QA can run' });
      }
      const { message, attachments: rawAttachments } = request.body ?? {};
      if (!message || !message.trim()) return reply.code(400).send({ error: 'message is required' });

      let attachments;
      try {
        attachments = await parseAttachments(rawAttachments ?? []);
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
      }

            startEventStream(reply);

      const send = (event: AgentEvent) => reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);

      try {
        await runQaAgentTurn(session, message, send, attachments);
      } catch (err) {
        send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      } finally {
        reply.raw.end();
      }
    }
  );

  app.get<{ Params: { id: string } }>('/api/sessions/:id/qa/report', async (request, reply) => {
    const session = await getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: 'session not found' });
    if (!session.qaReportPath) return { markdown: null };
    try {
      const markdown = await fs.readFile(path.join(config.harnessRoot, session.qaReportPath), 'utf8');
      return { markdown };
    } catch {
      return { markdown: null };
    }
  });

  // Human-only. Sends the QA findings back to Coding for fixes instead of
  // abandoning the whole session: reopens the coding chat (reverting the
  // earlier diff approval) and flags qaFindingsPending so CodingStage
  // relays the report content as the agent's next message. The QA report
  // and transcript are left exactly as they are — the record of what was
  // found — a fresh QA pass happens once the human re-approves coding.
  //
  // Also doubles as the recovery path when QA itself was interrupted before
  // it ever wrote a report (e.g. it hit a provider usage/session limit on
  // its first turn) — there is no other way to un-stick a session once
  // codingApprovedAt is set, so this must not require qaReportPath to
  // exist. qaFindingsPending only gets set when there's an actual report to
  // relay; otherwise CodingStage just reopens with nothing auto-injected.
  app.post<{ Params: { id: string } }>('/api/sessions/:id/qa/send-back', async (request, reply) => {
    const session = await getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: 'session not found' });
    return updateSession(session.id, {
      codingApprovedAt: null,
      stage: 'coding-review',
      qaFindingsPending: Boolean(session.qaReportPath),
    });
  });

  // Human-only. Reaching "done" here never pushes, merges, or opens an MR —
  // it just marks the session complete with the branch/report surfaced for
  // the developer to act on manually.
  app.post<{ Params: { id: string } }>('/api/sessions/:id/qa/approve', async (request, reply) => {
    const session = await getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: 'session not found' });
    if (!session.qaReportPath) {
      return reply.code(400).send({ error: 'no QA report has been written yet' });
    }

    const filePath = path.join(config.harnessRoot, session.qaReportPath);
    const raw = await fs.readFile(filePath, 'utf8');
    const updated = raw.replace(/^status:\s*\S+/m, 'status: reviewed');
    await fs.writeFile(filePath, updated, 'utf8');

    return updateSession(session.id, { qaStatus: 'reviewed', stage: 'done' });
  });

  // Human-only. Branch and report are left in place for manual follow-up —
  // rejecting at QA never deletes anything, it just stops the pipeline here.
  app.post<{ Params: { id: string } }>('/api/sessions/:id/qa/reject', async (request, reply) => {
    const session = await getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: 'session not found' });
    return updateSession(session.id, { stage: 'abandoned' });
  });
}
