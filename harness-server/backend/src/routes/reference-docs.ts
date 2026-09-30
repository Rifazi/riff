import type { FastifyInstance, FastifyReply } from 'fastify';
import { getSession } from '../sessions/session-store.js';
import { listApps } from '../apps/apps-store.js';
import { parseAttachments, type AttachmentInput } from '../agents/attachments.js';
import {
  addReferenceDocs,
  isReferenceDocId,
  listReferenceDocs,
  removeReferenceDoc,
  shareWithApp,
  type ReferenceScope,
} from '../sessions/reference-docs.js';

// Human-managed documents every agent can read (sessions/reference-docs.ts):
// an app's are shared by all of its sessions, a session's by all of its
// stages. Chat attachments are added to the session's automatically by the
// stage message routes; these routes are for managing them directly.
export async function registerReferenceDocRoutes(app: FastifyInstance): Promise<void> {
  async function upload(scope: ReferenceScope, raw: AttachmentInput[] | undefined, reply: FastifyReply) {
    if (!raw?.length) return reply.code(400).send({ error: 'attach at least one file' });
    try {
      return reply.code(201).send(await addReferenceDocs(scope, await parseAttachments(raw)));
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  }

  async function knownApp(appId: string): Promise<boolean> {
    return (await listApps()).some((a) => a.id === appId);
  }

  app.get<{ Params: { id: string } }>('/api/apps/:id/reference-docs', async (request, reply) => {
    if (!(await knownApp(request.params.id))) return reply.code(404).send({ error: 'app not found' });
    return listReferenceDocs({ kind: 'app', appId: request.params.id });
  });

  app.post<{ Params: { id: string }; Body: { attachments?: AttachmentInput[] } }>('/api/apps/:id/reference-docs', async (request, reply) => {
    if (!(await knownApp(request.params.id))) return reply.code(404).send({ error: 'app not found' });
    return upload({ kind: 'app', appId: request.params.id }, request.body?.attachments, reply);
  });

  app.delete<{ Params: { id: string; docId: string } }>('/api/apps/:id/reference-docs/:docId', async (request, reply) => {
    const { id, docId } = request.params;
    if (!isReferenceDocId(docId) || !(await removeReferenceDoc({ kind: 'app', appId: id }, docId))) {
      return reply.code(404).send({ error: 'reference document not found' });
    }
    return reply.code(204).send();
  });

  // Both lists, since the session's agents see both.
  app.get<{ Params: { id: string } }>('/api/sessions/:id/reference-docs', async (request, reply) => {
    const session = await getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: 'session not found' });
    const [appDocs, sessionDocs] = await Promise.all([
      listReferenceDocs({ kind: 'app', appId: session.appId }),
      listReferenceDocs({ kind: 'session', sessionId: session.id }),
    ]);
    return { app: appDocs, session: sessionDocs };
  });

  app.post<{ Params: { id: string }; Body: { attachments?: AttachmentInput[] } }>(
    '/api/sessions/:id/reference-docs',
    async (request, reply) => {
      const session = await getSession(request.params.id);
      if (!session) return reply.code(404).send({ error: 'session not found' });
      return upload({ kind: 'session', sessionId: session.id }, request.body?.attachments, reply);
    }
  );

  app.delete<{ Params: { id: string; docId: string } }>('/api/sessions/:id/reference-docs/:docId', async (request, reply) => {
    const { id, docId } = request.params;
    const session = await getSession(id);
    if (!session) return reply.code(404).send({ error: 'session not found' });
    if (!isReferenceDocId(docId) || !(await removeReferenceDoc({ kind: 'session', sessionId: id }, docId))) {
      return reply.code(404).send({ error: 'reference document not found' });
    }
    return reply.code(204).send();
  });

  // Moves a session's document to its app, for every future session too.
  app.post<{ Params: { id: string; docId: string } }>('/api/sessions/:id/reference-docs/:docId/share', async (request, reply) => {
    const { id, docId } = request.params;
    const session = await getSession(id);
    if (!session) return reply.code(404).send({ error: 'session not found' });
    const shared = isReferenceDocId(docId) ? await shareWithApp(session.id, session.appId, docId) : null;
    if (!shared) return reply.code(404).send({ error: 'reference document not found' });
    return shared;
  });
}
