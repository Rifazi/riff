import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { startEventStream } from './sse.js';
import { config } from '../config.js';
import { getSession, updateSession } from '../sessions/session-store.js';
import { runQaAgentTurn } from '../agents/qa-agent.js';
import { parseAttachments, type AttachmentInput } from '../agents/attachments.js';
import type { AgentEvent } from '../agents/sdk-client.js';
import matter from 'gray-matter';
import { getApp } from '../apps/apps-store.js';
import { baseBranchFor } from '../apps/apps.js';
import { deliver, detectDelivery } from '../repo/delivery.js';
import { resolveBaseBranch } from '../repo/git.js';
import type { SessionRecord } from '../sessions/session.js';

async function deliveryText(session: SessionRecord): Promise<{ title: string; description: string }> {
  let qa = '';
  if (session.qaReportPath) {
    try {
      const parsed = matter(await fs.readFile(path.join(config.harnessRoot, session.qaReportPath), 'utf8'));
      const d = parsed.data as Record<string, unknown>;
      qa = `QA: ${d.result ?? '?'} (lint ${d.lint ?? '?'}, unit tests ${d['unit-tests'] ?? '?'}, integration ${d['integration-tests'] ?? '?'})\n\n${parsed.content.trim()}`;
    } catch {
      // report unreadable — ship without it
    }
  }
  const description = `${session.title} (${session.sessionKey}), built with Riff Dev Sessions.\n\n${qa}`.slice(0, 60_000);
  return { title: `${session.sessionKey}: ${session.title}`, description };
}

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
  //
  // Also undoes an earlier "Mark reviewed" (stage 'done') — the report goes
  // back to pending-review so the branch can't be shipped until a fresh QA
  // pass is reviewed. Refused once the branch has actually been merged or
  // an MR opened, since fixes on the branch would no longer reach anything.
  app.post<{ Params: { id: string } }>('/api/sessions/:id/qa/send-back', async (request, reply) => {
    const session = await getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: 'session not found' });
    if (session.delivery && session.delivery.kind !== 'pushed') {
      return reply.code(400).send({ error: `already delivered: ${session.delivery.detail}` });
    }
    if (session.qaStatus === 'reviewed' && session.qaReportPath) {
      const filePath = path.join(config.harnessRoot, session.qaReportPath);
      const raw = await fs.readFile(filePath, 'utf8');
      await fs.writeFile(filePath, raw.replace(/^status:\s*\S+/m, 'status: pending-review'), 'utf8');
    }
    return updateSession(session.id, {
      codingApprovedAt: null,
      stage: 'coding-review',
      qaFindingsPending: Boolean(session.qaReportPath),
      qaStatus: session.qaStatus === 'reviewed' ? 'pending-review' : session.qaStatus,
    });
  });

  // Human-only. Reaching "done" never pushes, merges, or opens an MR by
  // itself — that's the separate, explicitly-clicked /delivery below.
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

  // What shipping this branch would do, worked out from the repo (see
  // repo/delivery.ts). Read-only.
  app.get<{ Params: { id: string } }>('/api/sessions/:id/delivery', async (request, reply) => {
    const session = await getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: 'session not found' });
    if (!session.branch) return reply.code(400).send({ error: 'no branch to deliver yet' });
    const app = await getApp(session.appId);
    try {
      return await detectDelivery(app.repoRoot, session.branch, await resolveBaseBranch(app.repoRoot, baseBranchFor(app)));
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Human-only: merges the reviewed branch into the base branch (local
  // repo) or pushes it and opens an MR/PR (repo with a remote). Only after
  // QA is marked reviewed — no agent tool reaches this.
  app.post<{ Params: { id: string } }>('/api/sessions/:id/delivery', async (request, reply) => {
    const session = await getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: 'session not found' });
    if (!session.branch) return reply.code(400).send({ error: 'no branch to deliver yet' });
    if (session.qaStatus !== 'reviewed') return reply.code(400).send({ error: 'mark QA reviewed before shipping' });
    if (session.delivery && session.delivery.kind !== 'pushed') {
      return reply.code(400).send({ error: `already delivered: ${session.delivery.detail}` });
    }
    const app = await getApp(session.appId);
    try {
      const plan = await detectDelivery(app.repoRoot, session.branch, await resolveBaseBranch(app.repoRoot, baseBranchFor(app)));
      const result = await deliver(app.repoRoot, plan, await deliveryText(session));
      return updateSession(session.id, { delivery: result });
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Human-only. Branch and report are left in place for manual follow-up —
  // rejecting at QA never deletes anything, it just stops the pipeline here.
  app.post<{ Params: { id: string } }>('/api/sessions/:id/qa/reject', async (request, reply) => {
    const session = await getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: 'session not found' });
    return updateSession(session.id, { stage: 'abandoned' });
  });
}
