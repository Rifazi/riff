import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { createSession, deleteSession, getSession, listSessions, updateSession } from '../sessions/session-store.js';
import { slugify, type SessionRecord } from '../sessions/session.js';
import { stageGroupFor } from '../sessions/stage-group.js';
import { listApps } from '../apps/apps-store.js';
import { v4 as uuidv4 } from 'uuid';
import {
  removeMeetingSource,
  validateMeetingSourceInput,
  writeMeetingSource,
  type MeetingSourceInput,
} from '../sessions/meeting-source.js';

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

// Sessions don't store the app's display name (only its id, which can
// outlive a rename) — join against the current app list so the UI doesn't
// need a second round trip just to show which app a session targets.
async function withAppName(session: SessionRecord): Promise<SessionRecord & { appName: string }> {
  const apps = await listApps();
  const appName = apps.find((a) => a.id === session.appId)?.name ?? session.appId;
  return { ...session, appName };
}

export async function registerSessionRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { meetingId?: string } }>('/api/sessions', async (request) => {
    const { meetingId } = request.query ?? {};
    const sessions = (await listSessions()).filter((s) => !meetingId || s.sourceMeeting?.meetingId === meetingId);
    return Promise.all(sessions.map(withAppName));
  });

  app.post<{ Body: { title: string; sessionKey?: string; appId: string; source?: MeetingSourceInput } }>('/api/sessions', async (request, reply) => {
    const { title, sessionKey, appId, source } = request.body ?? {};
    if (!title || !title.trim()) {
      return reply.code(400).send({ error: 'title is required' });
    }
    if (!appId || !appId.trim()) {
      return reply.code(400).send({ error: 'appId is required' });
    }
    const apps = await listApps();
    if (!apps.some((a) => a.id === appId)) {
      return reply.code(400).send({ error: `unknown app: ${appId}` });
    }
    if (source !== undefined) {
      const sourceError = validateMeetingSourceInput(source);
      if (sourceError) return reply.code(400).send({ error: sourceError });
    }

    // Every stage's own agent derives its doc's filename straight from
    // sessionKey (requirementsDir/<key>.md, plansDir/<key>.md, ...) with no
    // further uniqueness check of its own — see requirements-agent.ts's
    // "does a file already exist at this path" adoption logic. Two sessions
    // sharing a key silently merge onto the same file: the newer session
    // would inherit the older one's approved status on its very first turn,
    // and a later write would overwrite the older session's document
    // outright. Reject the collision here, once, before either can happen.
    const effectiveKey = sessionKey?.trim() || slugify(title);
    const existingSessions = await listSessions();
    const collidesWithSession = existingSessions.some((s) => s.sessionKey === effectiveKey);
    const collidesWithArtifact = collidesWithSession
      ? false
      : await Promise.all(
          [config.requirementsDir, config.plansDir, config.qaReportsDir].map((dir) =>
            fileExists(path.join(dir, `${effectiveKey}.md`))
          )
        ).then((hits) => hits.some(Boolean));
    if (collidesWithSession || collidesWithArtifact) {
      return reply.code(409).send({
        error: `"${effectiveKey}" is already in use by another session or an existing artifact doc — pick a different ticket ID, or open the existing session instead.`,
      });
    }

    const id = uuidv4();
    const sourceMeeting = source ? await writeMeetingSource(id, source) : null;
    const session = await createSession({ id, title, sessionKey, appId, sourceMeeting });
    return reply.code(201).send(await withAppName(session));
  });

  app.get<{ Params: { id: string } }>('/api/sessions/:id', async (request, reply) => {
    const session = await getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: 'session not found' });
    return withAppName(session);
  });

  // Human-only, permanent. Removes this project's own records for the
  // session (its state file, and the requirements/plan/QA docs it wrote
  // under artifacts/) — never touches Customer-EDI, so a session's branch
  // and commits (if any) are left exactly as they are for manual cleanup.
  app.delete<{ Params: { id: string } }>('/api/sessions/:id', async (request, reply) => {
    const session = await getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: 'session not found' });

    const artifactPaths = [session.requirementsPath, session.planPath, session.qaReportPath].filter(
      (p): p is string => Boolean(p)
    );
    for (const relPath of artifactPaths) {
      await fs.rm(path.join(config.harnessRoot, relPath), { force: true });
    }

    await removeMeetingSource(session.sourceMeeting);
    await deleteSession(session.id);
    return reply.code(204).send();
  });

  // Human-only. Undoes Reject: every */reject handler only ever sets
  // stage: 'abandoned' (session.ts has no "un-abandon" transition of its
  // own, and nothing else deletes a rejected session's data), so this just
  // resumes at whichever in-progress/review stage matches the artifacts
  // already on the session — the same rule stageGroupFor already uses to
  // route an abandoned session to a page. Coding's approval flag is
  // cleared so a session rejected while wrongly showing "approved" (e.g.
  // right after the interrupt-recovery bug this exists for) doesn't come
  // back read-only.
  app.post<{ Params: { id: string } }>('/api/sessions/:id/reopen', async (request, reply) => {
    const session = await getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: 'session not found' });
    if (session.stage !== 'abandoned') {
      return reply.code(400).send({ error: 'session is not abandoned' });
    }

    switch (stageGroupFor(session)) {
      case 'qa':
        return updateSession(session.id, { stage: 'qa-in-progress' });
      case 'coding':
        return updateSession(session.id, { stage: 'coding-review', codingApprovedAt: null });
      case 'plan':
        return updateSession(session.id, {
          stage: session.planStatus === 'approved' ? 'plan-approved' : 'plan-in-progress',
        });
      default:
        return updateSession(session.id, {
          stage: session.requirementsStatus === 'approved' ? 'requirements-approved' : 'requirements-in-progress',
        });
    }
  });
}
