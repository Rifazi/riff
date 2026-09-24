import { promises as fs } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import type { FastifyInstance } from 'fastify';
import { startEventStream } from './sse.js';
import { config } from '../config.js';
import { getSession, updateSession } from '../sessions/session-store.js';
import { stageGroupFor } from '../sessions/stage-group.js';
import { runPlanAgentTurn } from '../agents/plan-agent.js';
import { parseAttachments, type AttachmentInput } from '../agents/attachments.js';
import type { AgentEvent } from '../agents/sdk-client.js';
import { getJiraSettings } from '../settings/settings-store.js';
import { createTicketsFromPlan, type JiraPlanRecord } from '../jira/create-tickets-from-plan.js';
import { JiraError } from '../jira/jira-client.js';

export async function registerPlanRoutes(app: FastifyInstance): Promise<void> {
  // Streams the plan agent's turn back over SSE as it happens.
  app.post<{ Params: { id: string }; Body: { message: string; attachments?: AttachmentInput[] } }>(
    '/api/sessions/:id/plan/message',
    async (request, reply) => {
      const session = await getSession(request.params.id);
      if (!session) return reply.code(404).send({ error: 'session not found' });
      const { message, attachments: rawAttachments } = request.body ?? {};
      if (!message || !message.trim()) return reply.code(400).send({ error: 'message is required' });

      let attachments;
      try {
        attachments = await parseAttachments(rawAttachments ?? []);
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
      }

      // Same reasoning as requirements.ts's message route: clear the
      // one-shot relay flag before the turn runs, or the frontend's relay
      // effect re-sends the same note on every remount.
      if (session.planRelayPending) {
        await updateSession(session.id, { planRelayPending: false });
        session.planRelayPending = false;
      }

            startEventStream(reply);

      const send = (event: AgentEvent) => {
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      };

      try {
        await runPlanAgentTurn(session, message, send, attachments);
      } catch (err) {
        send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      } finally {
        reply.raw.end();
      }
    }
  );

  // The plan document's raw markdown, for the UI's live preview pane.
  // `body` is the same content with the YAML frontmatter stripped, for the
  // manual-edit textarea — editing must never touch status/created/steps,
  // only the body PUT below accepts. `steps` and `jira` are surfaced too so
  // the UI can render the "Create tickets in Jira" panel without a second
  // parse of the frontmatter.
  app.get<{ Params: { id: string } }>('/api/sessions/:id/plan/doc', async (request, reply) => {
    const session = await getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: 'session not found' });
    if (!session.planPath) return reply.send({ markdown: null, body: null, steps: [], jira: null });
    try {
      const markdown = await fs.readFile(path.join(config.harnessRoot, session.planPath), 'utf8');
      const parsed = matter(markdown);
      const body = parsed.content.trim();
      const steps = (parsed.data.steps ?? []) as { id: string; title: string }[];
      const jira = (parsed.data.jira as JiraPlanRecord | undefined) ?? null;
      return { markdown, body, steps, jira };
    } catch {
      return { markdown: null, body: null, steps: [], jira: null };
    }
  });

  // Human-only manual edit of the plan doc body — same rules as the
  // requirements doc's manual edit: blocked once coding has produced a
  // branch, unless the session has been deliberately reopened back into
  // this stage (coding/send-back-to-requirements, once requirements are
  // re-approved) — editing would otherwise invalidate work already in
  // progress from this plan. Editing an approved plan reverts it to draft.
  app.put<{ Params: { id: string }; Body: { markdownBody: string } }>('/api/sessions/:id/plan/doc', async (request, reply) => {
    const session = await getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: 'session not found' });
    if (!session.planPath) {
      return reply.code(400).send({ error: 'no plan document has been written yet' });
    }
    if (session.branch && stageGroupFor(session) !== 'plan') {
      return reply.code(400).send({ error: 'coding has already started from this plan — reject the session to start over' });
    }
    const { markdownBody } = request.body ?? {};
    if (typeof markdownBody !== 'string' || !markdownBody.trim()) {
      return reply.code(400).send({ error: 'markdownBody is required' });
    }

    const filePath = path.join(config.harnessRoot, session.planPath);
    let frontmatter: Record<string, unknown>;
    try {
      frontmatter = matter(await fs.readFile(filePath, 'utf8')).data;
    } catch {
      // File doesn't exist yet — a legitimate way to start one from
      // scratch, not an error. `steps` stays empty: the coding agent falls
      // back to proposing its own breakdown if this plan was never given a
      // structured step list (see coding-agent.ts).
      frontmatter = {
        ticket: session.sessionKey,
        created: new Date().toISOString().slice(0, 10),
        'author-agent': 'plan',
        session: session.id,
        'requirements-doc': session.requirementsPath,
        steps: [],
      };
    }
    const wasApproved = session.planStatus === 'approved';
    frontmatter.status = 'draft';
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const fileContents = matter.stringify(`\n${markdownBody.trim()}\n`, frontmatter);
    await fs.writeFile(filePath, fileContents, 'utf8');

    if (wasApproved) {
      await updateSession(session.id, { planStatus: 'draft', stage: 'plan-in-progress' });
    }

    return { markdown: fileContents };
  });

  // Human-only approval gate. No agent tool can reach this.
  app.post<{ Params: { id: string } }>('/api/sessions/:id/plan/approve', async (request, reply) => {
    const session = await getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: 'session not found' });
    if (!session.planPath) {
      return reply.code(400).send({ error: 'no plan document has been written yet' });
    }

    const filePath = path.join(config.harnessRoot, session.planPath);
    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf8');
    } catch {
      return reply.code(400).send({ error: `${session.planPath} doesn't exist on disk — write or restore its content before approving.` });
    }
    const updated = raw.replace(/^status:\s*\w+/m, 'status: approved');
    await fs.writeFile(filePath, updated, 'utf8');

    // A plan re-approved as part of a mid-coding send-back round trip
    // resumes the SAME branch — it jumps straight back to coding-review
    // (skipping plan-approved, which would otherwise wait for the coding
    // stage's own from-scratch kickoff) and flags coding to relay the
    // reconciliation context on its next turn instead of creating a new
    // branch.
    const resuming = session.reopenedFromCoding && Boolean(session.branch);
    const updatedSession = await updateSession(session.id, {
      planStatus: 'approved',
      stage: resuming ? 'coding-review' : 'plan-approved',
      ...(resuming ? { codingReconciliationPending: true } : {}),
    });
    return updatedSession;
  });

  // Human-only. Creates one Jira issue per plan step (skipping any step
  // that already has one recorded from an earlier call), all linked to the
  // epic that this session's own ticket (sessionKey) already belongs to in
  // Jira. Never called by an agent — same "no agent pushes/approves/opens
  // things on its own" boundary as git_create_branch.
  app.post<{ Params: { id: string } }>('/api/sessions/:id/plan/jira/create', async (request, reply) => {
    const session = await getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: 'session not found' });
    if (!session.planPath) return reply.code(400).send({ error: 'no plan document has been written yet' });
    if (session.planStatus !== 'approved') {
      return reply.code(400).send({ error: 'approve the plan before creating tickets in Jira' });
    }

    const jiraSettings = await getJiraSettings();
    try {
      const result = await createTicketsFromPlan(
        path.join(config.harnessRoot, session.planPath),
        session.sessionKey,
        session.title,
        jiraSettings
      );
      return result;
    } catch (err) {
      if (err instanceof JiraError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  // Human-only. Marks the draft superseded rather than deleting it.
  app.post<{ Params: { id: string } }>('/api/sessions/:id/plan/reject', async (request, reply) => {
    const session = await getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: 'session not found' });

    if (session.planPath) {
      const filePath = path.join(config.harnessRoot, session.planPath);
      const raw = await fs.readFile(filePath, 'utf8');
      const updated = raw.replace(/^status:\s*\S+/m, 'status: superseded');
      await fs.writeFile(filePath, updated, 'utf8');
    }

    return updateSession(session.id, {
      planStatus: session.planPath ? 'superseded' : session.planStatus,
      stage: 'abandoned',
    });
  });
}
