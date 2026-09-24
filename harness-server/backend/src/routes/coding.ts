import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { startEventStream } from './sse.js';
import { config } from '../config.js';
import { getSession, updateSession } from '../sessions/session-store.js';
import { runCodingAgentTurn } from '../agents/coding-agent.js';
import { parseAttachments, type AttachmentInput } from '../agents/attachments.js';
import { diffAgainstBase, diffStatAgainstBase, commitLogAgainstBase } from '../repo/git.js';
import { getApp } from '../apps/apps-store.js';
import type { AgentEvent } from '../agents/sdk-client.js';

// Mirrors the frontmatter rewrite the approve/reject routes already do for
// their own doc — revert to draft on disk too, not just on the session
// record, or the next agent turn's "trust the file's own status" reconciliation
// (requirements-agent.ts / plan-agent.ts, matching write_requirements_doc's
// own always-draft convention) will read the still-"approved" file and flip
// the session's status straight back, silently re-locking the chat.
async function revertDocToDraftOnDisk(relPath: string | null): Promise<void> {
  if (!relPath) return;
  const filePath = path.join(config.harnessRoot, relPath);
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const updated = raw.replace(/^status:\s*\w+/m, 'status: draft');
    await fs.writeFile(filePath, updated, 'utf8');
  } catch {
    // doc doesn't exist on disk — nothing to revert
  }
}

export async function registerCodingRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { id: string }; Body: { message: string; attachments?: AttachmentInput[] } }>(
    '/api/sessions/:id/coding/message',
    async (request, reply) => {
      const session = await getSession(request.params.id);
      if (!session) return reply.code(404).send({ error: 'session not found' });
      if (session.requirementsStatus !== 'approved' || session.planStatus !== 'approved') {
        return reply.code(400).send({ error: 'requirements and plan must both be approved before coding can start' });
      }
      const { message, attachments: rawAttachments } = request.body ?? {};
      if (!message || !message.trim()) return reply.code(400).send({ error: 'message is required' });

      let attachments;
      try {
        attachments = await parseAttachments(rawAttachments ?? []);
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
      }

      // Any message here counts as having relayed pending QA findings /
      // post-reconciliation context, whether it's the auto-composed one or
      // the human typing something else instead — clear both flags before
      // the turn runs.
      if (session.qaFindingsPending || session.codingReconciliationPending) {
        await updateSession(session.id, { qaFindingsPending: false, codingReconciliationPending: false });
        session.qaFindingsPending = false;
        session.codingReconciliationPending = false;
      }

            startEventStream(reply);

      const send = (event: AgentEvent) => reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);

      try {
        await runCodingAgentTurn(session, message, send, attachments);
      } catch (err) {
        send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      } finally {
        reply.raw.end();
      }
    }
  );

  app.get<{ Params: { id: string } }>('/api/sessions/:id/coding/diff', async (request, reply) => {
    const session = await getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: 'session not found' });
    if (!session.branch) return { diff: null, stat: null, commits: [] };
    const app = await getApp(session.appId);
    const [diff, stat, commits] = await Promise.all([
      diffAgainstBase(app.repoRoot, session.branch),
      diffStatAgainstBase(app.repoRoot, session.branch),
      commitLogAgainstBase(app.repoRoot, session.branch),
    ]);
    return { diff, stat, commits };
  });

  // Human-only: approving the diff both moves past the coding gate AND
  // kicks off QA automatically (the frontend starts the QA turn once it
  // observes the new stage) — QA still has its own separate approval gate.
  app.post<{ Params: { id: string } }>('/api/sessions/:id/coding/approve', async (request, reply) => {
    const session = await getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: 'session not found' });
    if (!session.branch) {
      return reply.code(400).send({ error: 'no commits exist on a branch yet' });
    }
    return updateSession(session.id, {
      stage: 'qa-in-progress',
      codingApprovedAt: new Date().toISOString(),
    });
  });

  // Human-only. Reopens Requirements mid-coding instead of rejecting the
  // whole session — for when a change of mind mid-implementation means
  // requirements (and, once re-approved, the plan) need to be revised
  // against work that's already partially built. The branch, commits,
  // codingPlan checklist, and coding transcript/history are all left
  // exactly as-is; only the stage pointer and the relay flags that drive
  // the requirements/plan/coding agents' awareness of this round trip
  // change. Requires an existing branch — sending back before any code
  // exists is meaningless (reject instead).
  app.post<{ Params: { id: string }; Body: { note: string } }>(
    '/api/sessions/:id/coding/send-back-to-requirements',
    async (request, reply) => {
      const session = await getSession(request.params.id);
      if (!session) return reply.code(404).send({ error: 'session not found' });
      if (!session.branch) {
        return reply.code(400).send({ error: 'no coding work exists yet to send back from' });
      }
      const { note } = request.body ?? {};
      if (!note || !note.trim()) return reply.code(400).send({ error: 'a note describing what needs to change is required' });

      await revertDocToDraftOnDisk(session.requirementsPath);
      await revertDocToDraftOnDisk(session.planPath);

      return updateSession(session.id, {
        stage: 'requirements-in-progress',
        requirementsStatus: 'draft',
        planStatus: session.planPath ? 'draft' : session.planStatus,
        qaFindingsPending: false,
        reopenedFromCoding: true,
        pendingRequirementsRelayNote: note.trim(),
        requirementsRelayPending: true,
        planRelayPending: false,
        codingReconciliationPending: false,
      });
    }
  );

  // Human-only. The branch (if any) is left exactly as-is — never deleted —
  // so a rejected session's work is still inspectable/recoverable manually.
  app.post<{ Params: { id: string } }>('/api/sessions/:id/coding/reject', async (request, reply) => {
    const session = await getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: 'session not found' });
    return updateSession(session.id, { stage: 'abandoned' });
  });
}
