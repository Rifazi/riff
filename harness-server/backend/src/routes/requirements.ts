import { promises as fs } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import type { FastifyInstance } from 'fastify';
import { startEventStream } from './sse.js';
import { config } from '../config.js';
import { getSession, updateSession } from '../sessions/session-store.js';
import { stageGroupFor } from '../sessions/stage-group.js';
import { runRequirementsAgentTurn } from '../agents/requirements-agent.js';
import { parseAttachments, type AttachmentInput } from '../agents/attachments.js';
import { readMeetingSourceAttachment } from '../sessions/meeting-source.js';
import type { AgentEvent } from '../agents/sdk-client.js';

export async function registerRequirementsRoutes(app: FastifyInstance): Promise<void> {
  // Streams the requirements agent's turn back over SSE as it happens.
  app.post<{ Params: { id: string }; Body: { message: string; attachments?: AttachmentInput[] } }>(
    '/api/sessions/:id/requirements/message',
    async (request, reply) => {
      const session = await getSession(request.params.id);
      if (!session) return reply.code(404).send({ error: 'session not found' });
      const { message, attachments: rawAttachments } = request.body ?? {};
      if (!message || !message.trim()) return reply.code(400).send({ error: 'message is required' });

      // Parsed before the SSE hijack below so a bad attachment (oversized,
      // unsupported type, unreadable PDF) comes back as a normal 400 instead
      // of a mid-stream error event.
      let attachments;
      try {
        attachments = await parseAttachments(rawAttachments ?? []);
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
      }

      // Any message here counts as having relayed the pending mid-coding
      // send-back note, whether it's the auto-composed one or the human
      // typing something else instead — clear it before the turn runs, or
      // the frontend's one-shot relay effect re-sends the same note on
      // every remount for as long as this stays true (mirrors
      // qaFindingsPending's clear-on-next-message in coding.ts).
      if (session.requirementsRelayPending) {
        await updateSession(session.id, { requirementsRelayPending: false });
        session.requirementsRelayPending = false;
      }

      // Same clear-on-next-message rule for a session started from a
      // meeting: whatever the first message is, it carries the transcript.
      if (session.meetingKickoffPending && session.sourceMeeting) {
        try {
          attachments = [await readMeetingSourceAttachment(session.sourceMeeting), ...attachments];
        } catch (err) {
          return reply.code(400).send({
            error: `meeting transcript for this session could not be read: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
        await updateSession(session.id, { meetingKickoffPending: false });
        session.meetingKickoffPending = false;
      }

            startEventStream(reply);

      const send = (event: AgentEvent) => {
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      };

      try {
        await runRequirementsAgentTurn(session, message, send, attachments);
      } catch (err) {
        send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      } finally {
        reply.raw.end();
      }
    }
  );

  // The requirements document's raw markdown, for the UI's live preview
  // pane. `body` is the same content with the YAML frontmatter stripped,
  // for the manual-edit textarea — editing must never touch status/created/
  // related-docs, only the body PUT above accepts.
  app.get<{ Params: { id: string } }>('/api/sessions/:id/requirements/doc', async (request, reply) => {
    const session = await getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: 'session not found' });
    if (!session.requirementsPath) return reply.send({ markdown: null, body: null });
    try {
      const markdown = await fs.readFile(path.join(config.harnessRoot, session.requirementsPath), 'utf8');
      const body = matter(markdown).content.trim();
      return { markdown, body };
    } catch {
      return { markdown: null, body: null };
    }
  });

  // Human-only manual edit of the requirements doc body — lets the human
  // maintain the acceptance-criteria list directly instead of only via
  // chat. Allowed any time coding hasn't produced a branch yet, OR while a
  // branch exists but the session has been deliberately reopened back into
  // this stage (coding/send-back-to-requirements) — in every other case
  // where a branch exists, editing would silently invalidate work in
  // progress underneath an unrelated stage, so that's still blocked
  // (reject the session to start over instead). Editing an *approved* doc
  // reverts it to draft — the approval was of the old text, and the new
  // text needs its own explicit approval, same principle as everywhere
  // else in this app ("nothing is final until a human clicks Approve").
  // Frontmatter itself (created, related-docs, etc.) is preserved as-is;
  // only the body and `status` change.
  app.put<{ Params: { id: string }; Body: { markdownBody: string } }>(
    '/api/sessions/:id/requirements/doc',
    async (request, reply) => {
      const session = await getSession(request.params.id);
      if (!session) return reply.code(404).send({ error: 'session not found' });
      if (!session.requirementsPath) {
        return reply.code(400).send({ error: 'no requirements document has been written yet' });
      }
      if (session.branch && stageGroupFor(session) !== 'requirements') {
        return reply
          .code(400)
          .send({ error: 'coding has already started from this requirements doc — reject the session to start over' });
      }
      const { markdownBody } = request.body ?? {};
      if (typeof markdownBody !== 'string' || !markdownBody.trim()) {
        return reply.code(400).send({ error: 'markdownBody is required' });
      }

      const filePath = path.join(config.harnessRoot, session.requirementsPath);
      let frontmatter: Record<string, unknown>;
      try {
        frontmatter = matter(await fs.readFile(filePath, 'utf8')).data;
      } catch {
        // File doesn't exist (deleted outside the app, or never written by
        // the agent yet) — this is a legitimate way to start one from
        // scratch, not an error. Fall back to sensible defaults.
        frontmatter = {
          ticket: session.sessionKey,
          created: new Date().toISOString().slice(0, 10),
          'author-agent': 'requirements',
          session: session.id,
          'related-docs': [],
        };
      }
      const wasApproved = session.requirementsStatus === 'approved';
      // A manually-saved doc is always draft — the only other statuses
      // (approved, superseded) are set exclusively by the dedicated
      // approve/reject endpoints, never by a plain content write.
      frontmatter.status = 'draft';
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      const fileContents = matter.stringify(`\n${markdownBody.trim()}\n`, frontmatter);
      await fs.writeFile(filePath, fileContents, 'utf8');

      if (wasApproved) {
        await updateSession(session.id, { requirementsStatus: 'draft', stage: 'requirements-in-progress' });
      }

      return { markdown: fileContents };
    }
  );

  // Human-only approval gate. No agent tool can reach this — it is the
  // literal enforcement of "the model cannot approve its own work."
  app.post<{ Params: { id: string } }>('/api/sessions/:id/requirements/approve', async (request, reply) => {
    const session = await getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: 'session not found' });
    if (!session.requirementsPath) {
      return reply.code(400).send({ error: 'no requirements document has been written yet' });
    }

    const filePath = path.join(config.harnessRoot, session.requirementsPath);
    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf8');
    } catch {
      return reply
        .code(400)
        .send({ error: `${session.requirementsPath} doesn't exist on disk — write or restore its content before approving.` });
    }
    const updated = raw.replace(/^status:\s*\w+/m, 'status: approved');
    await fs.writeFile(filePath, updated, 'utf8');

    const updatedSession = await updateSession(session.id, {
      requirementsStatus: 'approved',
      stage: 'requirements-approved',
      // A revision that got here via a mid-coding send-back needs the plan
      // to reconcile against it too before coding resumes — flag Plan to
      // auto-relay the note the moment it's reached.
      ...(session.reopenedFromCoding ? { planRelayPending: true } : {}),
    });
    return updatedSession;
  });

  // Human-only. Marks the draft superseded rather than deleting it — git
  // history (once committed) is the record, not a destructive removal.
  app.post<{ Params: { id: string } }>('/api/sessions/:id/requirements/reject', async (request, reply) => {
    const session = await getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: 'session not found' });

    if (session.requirementsPath) {
      const filePath = path.join(config.harnessRoot, session.requirementsPath);
      const raw = await fs.readFile(filePath, 'utf8');
      const updated = raw.replace(/^status:\s*\S+/m, 'status: superseded');
      await fs.writeFile(filePath, updated, 'utf8');
    }

    return updateSession(session.id, {
      requirementsStatus: session.requirementsPath ? 'superseded' : session.requirementsStatus,
      stage: 'abandoned',
    });
  });
}
