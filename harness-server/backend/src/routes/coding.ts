import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { startEventStream } from './sse.js';
import { config } from '../config.js';
import { getSession, updateSession } from '../sessions/session-store.js';
import { runCodingAgentTurn } from '../agents/coding-agent.js';
import { parseAttachments, saveAsReferenceDocs, type AttachmentInput } from '../agents/attachments.js';
import { diffAgainstBase, diffStatAgainstBase, commitLogAgainstBase } from '../repo/git.js';
import { getApp } from '../apps/apps-store.js';
import { baseBranchFor } from '../apps/apps.js';
import type { AgentEvent } from '../agents/sdk-client.js';
import { isTeamRunning, runCodingTeam, type TeamEvent } from '../agents/team/coding-team.js';
import { restartLiveMember } from '../agents/team/team-state.js';

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
  app.post<{ Params: { id: string }; Body: { message: string; attachments?: AttachmentInput[]; stepTurn?: boolean } }>(
    '/api/sessions/:id/coding/message',
    async (request, reply) => {
      const session = await getSession(request.params.id);
      if (!session) return reply.code(404).send({ error: 'session not found' });
      if (session.requirementsStatus !== 'approved' || session.planStatus !== 'approved') {
        return reply.code(400).send({ error: 'requirements and plan must both be approved before coding can start' });
      }
      if (isTeamRunning(session.id)) {
        return reply.code(409).send({ error: 'the coding team is still working — wait for it to finish before messaging the lead' });
      }
      const { message, attachments: rawAttachments, stepTurn } = request.body ?? {};
      if (!message || !message.trim()) return reply.code(400).send({ error: 'message is required' });

      let attachments;
      try {
        attachments = await saveAsReferenceDocs(session.id, await parseAttachments(rawAttachments ?? []));
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
      }

      // Any message here counts as having relayed pending QA findings /
      // post-reconciliation context, whether it's the auto-composed one or
      // the human typing something else instead — clear both flags before
      // the turn runs.
      const qaFix = session.qaFindingsPending;
      if (session.qaFindingsPending || session.codingReconciliationPending) {
        await updateSession(session.id, { qaFindingsPending: false, codingReconciliationPending: false });
        session.qaFindingsPending = false;
        session.codingReconciliationPending = false;
      }

            startEventStream(reply);

      const send = (event: AgentEvent) => reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);

      try {
        await runCodingAgentTurn(session, message, send, attachments, { stepTurn: stepTurn === true, qaFix });
      } catch (err) {
        send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      } finally {
        reply.raw.end();
      }
    }
  );

  // SSE. Starts (or resumes) the coding team for a plan with workstreams —
  // every member's events are tagged with its memberId. Resuming re-runs
  // only the members that haven't merged yet.
  app.post<{ Params: { id: string } }>('/api/sessions/:id/coding/team/run', async (request, reply) => {
    const session = await getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: 'session not found' });
    if (isTeamRunning(session.id)) return reply.code(409).send({ error: 'the coding team is already running' });
    if (session.codingApprovedAt) return reply.code(400).send({ error: 'coding is already approved' });

    startEventStream(reply);
    const send = (event: TeamEvent) => reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    try {
      await runCodingTeam(session.id, send);
    } catch (err) {
      send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      reply.raw.end();
    }
  });

  // Restarts one engineer inside the team's live run: a running one is
  // stopped and starts over, a failed one runs again straight away. With no
  // run going ({ live: false }) the caller resumes the team instead.
  app.post<{ Params: { id: string; memberId: string } }>('/api/sessions/:id/coding/team/members/:memberId/restart', async (request, reply) => {
    const session = await getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: 'session not found' });
    const { live, error } = await restartLiveMember('coding', session.id, request.params.memberId);
    if (error) return reply.code(409).send({ error });
    return { live };
  });

  app.get<{ Params: { id: string } }>('/api/sessions/:id/coding/team', async (request, reply) => {
    const session = await getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: 'session not found' });
    return { running: isTeamRunning(session.id) };
  });

  app.get<{ Params: { id: string } }>('/api/sessions/:id/coding/diff', async (request, reply) => {
    const session = await getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: 'session not found' });
    if (!session.branch) return { diff: null, stat: null, commits: [] };
    const app = await getApp(session.appId);
    const [diff, stat, commits] = await Promise.all([
      diffAgainstBase(app.repoRoot, session.branch, baseBranchFor(app)),
      diffStatAgainstBase(app.repoRoot, session.branch, baseBranchFor(app)),
      commitLogAgainstBase(app.repoRoot, session.branch, baseBranchFor(app)),
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
    // The coding agent's notes go over with the branch (qa-agent.ts).
    return updateSession(session.id, {
      stage: 'qa-in-progress',
      codingApprovedAt: new Date().toISOString(),
      qaNotes: [],
      qaHandoffNotes: session.qaNotes,
      qaRerunPending: session.transcripts.qa.length > 0,
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
