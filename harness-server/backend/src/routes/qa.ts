import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { startEventStream } from './sse.js';
import { config } from '../config.js';
import { getSession, updateSession } from '../sessions/session-store.js';
import { runQaAgentTurn } from '../agents/qa-agent.js';
import { parseAttachments, saveAsReferenceDocs, type AttachmentInput } from '../agents/attachments.js';
import type { AgentEvent } from '../agents/sdk-client.js';
import { compactQaFindings } from '../sessions/qa-findings.js';
import { qaLoopFor } from '../sessions/qa-rounds.js';
import { qaReportIsCurrent } from '../sessions/qa-loop.js';
import type { SessionRecord } from '../sessions/session.js';
import { getApp } from '../apps/apps-store.js';
import { isQaTeamRunning, runQaTeam } from '../agents/team/qa-team.js';
import type { TeamEvent } from '../agents/team/coding-team.js';
import { restartLiveMember } from '../agents/team/team-state.js';
import { approveQa, deliverSession, keepSessionOnBranch, planDelivery } from '../sessions/stage-actions.js';
import { isShipped } from '../sessions/shared-branch.js';
import { sendStageActionError } from './stage-action-reply.js';

export async function registerQaRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { id: string }; Body: { message: string; attachments?: AttachmentInput[] } }>(
    '/api/sessions/:id/qa/message',
    async (request, reply) => {
      const session = await getSession(request.params.id);
      if (!session) return reply.code(404).send({ error: 'session not found' });
      if (!session.branch) {
        return reply.code(400).send({ error: 'coding must be approved (a branch must exist) before QA can run' });
      }
      if (isQaTeamRunning(session.id)) {
        return reply.code(409).send({ error: 'the QA team is still reviewing — wait for it to finish before messaging the lead' });
      }
      const { message, attachments: rawAttachments } = request.body ?? {};
      if (!message || !message.trim()) return reply.code(400).send({ error: 'message is required' });

      let attachments;
      try {
        attachments = await saveAsReferenceDocs(session.id, await parseAttachments(rawAttachments ?? []));
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

  // SSE. Starts (or resumes) the review the QA lead split across a team —
  // every reviewer's events are tagged with its memberId (same framing as
  // /coding/team/run). Resuming re-runs only reviewers without findings.
  app.post<{ Params: { id: string } }>('/api/sessions/:id/qa/team/run', async (request, reply) => {
    const session = await getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: 'session not found' });
    if (isQaTeamRunning(session.id)) return reply.code(409).send({ error: 'the QA team is already running' });
    if (session.qaStatus === 'reviewed') return reply.code(400).send({ error: 'QA is already marked reviewed' });

    startEventStream(reply);
    const send = (event: TeamEvent) => reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    try {
      await runQaTeam(session.id, send);
    } catch (err) {
      send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      reply.raw.end();
    }
  });

  // Restarts one reviewer inside the team's live run: a running one is
  // stopped and starts over, a failed one runs again straight away. With no
  // run going ({ live: false }) the caller resumes the team instead.
  app.post<{ Params: { id: string; memberId: string } }>('/api/sessions/:id/qa/team/members/:memberId/restart', async (request, reply) => {
    const session = await getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: 'session not found' });
    const { live, error } = await restartLiveMember('qa', session.id, request.params.memberId);
    if (error) return reply.code(409).send({ error });
    return { live };
  });

  app.get<{ Params: { id: string } }>('/api/sessions/:id/qa/team', async (request, reply) => {
    const session = await getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: 'session not found' });
    return { running: isQaTeamRunning(session.id) };
  });

  // The report on file, or with ?pass= an earlier pass's copy (qa-rounds.ts
  // keepPassReport). `passes` lists every recorded pass for the QA tab's picker.
  app.get<{ Params: { id: string }; Querystring: { pass?: string } }>('/api/sessions/:id/qa/report', async (request, reply) => {
    const session = await getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: 'session not found' });
    const current = qaReportIsCurrent(session);
    const passes = session.qaRounds.map((r) => ({
      pass: r.pass,
      at: r.at,
      result: r.result,
      hasReport: Boolean(r.reportPath) || (current && r.pass === session.qaPass),
    }));
    const read = async (rel: string | null | undefined) => {
      if (!rel) return null;
      try {
        return await fs.readFile(path.join(config.harnessRoot, rel), 'utf8');
      } catch {
        return null;
      }
    };
    const wanted = Number(request.query.pass);
    if (request.query.pass !== undefined && Number.isInteger(wanted)) {
      const round = session.qaRounds.find((r) => r.pass === wanted);
      const fallback = current && wanted === session.qaPass ? session.qaReportPath : null;
      const markdown = (await read(round?.reportPath)) ?? (await read(fallback));
      return { markdown, current: current && wanted === session.qaPass, pass: wanted, passes };
    }
    return { markdown: await read(session.qaReportPath), current, pass: session.qaPass, passes };
  });

  // What the coding agent gets when QA sends a branch back: only the things
  // it must fix, not the full report (passed criteria, nits, summary) — the
  // human still has that in the QA tab.
  app.get<{ Params: { id: string } }>('/api/sessions/:id/qa/findings', async (request, reply) => {
    const session = await getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: 'session not found' });
    if (!session.qaReportPath || !qaReportIsCurrent(session)) return { text: null };
    let raw: string;
    try {
      raw = await fs.readFile(path.join(config.harnessRoot, session.qaReportPath), 'utf8');
    } catch {
      return { text: null };
    }
    const loop = await loopFor(session);
    return { text: compactQaFindings(raw, loop) };
  });

  // Why the latest QA pass failed compared with the earlier ones (sessions/qa-loop.ts),
  // or null when it didn't fail. The QA tab shows it when the branch is looping.
  app.get<{ Params: { id: string } }>('/api/sessions/:id/qa/loop', async (request, reply) => {
    const session = await getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: 'session not found' });
    return { loop: await loopFor(session) };
  });

  // The human, or the coordinator when the report fails. Sends the QA findings back to Coding for fixes instead of
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
    if (isShipped(session.delivery)) {
      return reply.code(400).send({ error: `already delivered: ${session.delivery!.detail}` });
    }
    if (isQaTeamRunning(session.id)) return reply.code(409).send({ error: 'the QA team is still reviewing' });
    if (session.qaStatus === 'reviewed' && session.qaReportPath) {
      const filePath = path.join(config.harnessRoot, session.qaReportPath);
      const raw = await fs.readFile(filePath, 'utf8');
      await fs.writeFile(filePath, raw.replace(/^status:\s*\S+/m, 'status: pending-review'), 'utf8');
    }
    // The team that built what QA reviewed is done: it moves to history so
    // the fix pass starts with Jack alone, until he assigns a new round.
    const retireTeam = session.codingTeam && session.codingTeam.status !== 'assigned';
    return updateSession(session.id, {
      codingApprovedAt: null,
      // A part kept on its branch for the next part is back in progress.
      ...(session.delivery?.kind === 'kept' && { delivery: null }),
      stage: 'coding-review',
      // A report from an earlier pass would send the coder findings it may
      // already have fixed: then coding reopens with nothing relayed.
      qaFindingsPending: qaReportIsCurrent(session),
      qaStatus: session.qaStatus === 'reviewed' ? 'pending-review' : session.qaStatus,
      ...(retireTeam && {
        codingTeam: null,
        codingTeamHistory: [...session.codingTeamHistory, session.codingTeam!],
      }),
    });
  });

  // Marks QA reviewed (the human, or Bridget on a clean pass). Reaching
  // "done" never pushes, merges, or opens an MR by itself — that's the
  // separate /delivery below.
  app.post<{ Params: { id: string } }>('/api/sessions/:id/qa/approve', async (request, reply) => {
    const session = await getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: 'session not found' });
    try {
      return await approveQa(session);
    } catch (err) {
      return sendStageActionError(reply, err);
    }
  });

  // What shipping this branch would do, worked out from the repo (see
  // repo/delivery.ts). Read-only.
  app.get<{ Params: { id: string } }>('/api/sessions/:id/delivery', async (request, reply) => {
    const session = await getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: 'session not found' });
    try {
      return await planDelivery(session);
    } catch (err) {
      return sendStageActionError(reply, err);
    }
  });

  // Merges the reviewed branch into the base branch (local repo) or pushes
  // it and opens an MR/PR (repo with a remote). Only after QA is marked
  // reviewed. The human's Ship button, or Bridget after a clean QA pass
  // (an MR only — she never merges into the base branch herself).
  app.post<{ Params: { id: string } }>('/api/sessions/:id/delivery', async (request, reply) => {
    const session = await getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: 'session not found' });
    try {
      return await deliverSession(session);
    } catch (err) {
      return sendStageActionError(reply, err);
    }
  });

  // A split part's alternative to shipping: leaves the reviewed branch as it
  // is, and the next part continues on it (sessions/shared-branch.ts).
  app.post<{ Params: { id: string } }>('/api/sessions/:id/delivery/keep', async (request, reply) => {
    const session = await getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: 'session not found' });
    try {
      return await keepSessionOnBranch(session);
    } catch (err) {
      return sendStageActionError(reply, err);
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

async function loopFor(session: SessionRecord) {
  if (!qaReportIsCurrent(session)) return null;
  try {
    return await qaLoopFor(session, (await getApp(session.appId)).repoRoot);
  } catch {
    return null;
  }
}
