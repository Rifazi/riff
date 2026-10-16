import { promises as fs } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { config } from '../config.js';
import { getApp } from '../apps/apps-store.js';
import { baseBranchFor } from '../apps/apps.js';
import { tryCompressPlanPreamble } from '../agents/helpers/compress.js';
import { deliver, detectDelivery, type DeliveryPlan } from '../repo/delivery.js';
import { buildDeliveryText } from '../repo/delivery-text.js';
import { resolveBaseBranch } from '../repo/git.js';
import { updateSession } from './session-store.js';
import { loadSplitRoadmap } from './split-roadmap-load.js';
import { isShipped, keepOnBranch, recordSharedBranchShipped } from './shared-branch.js';
import type { SessionRecord } from './session.js';
import { qaReportIsCurrent } from './qa-loop.js';

// The approval gates, shared by the stage tabs' buttons (routes/*.ts) and
// Bridget, the coordinator, who approves on the human's behalf when nothing
// needs them (routes/coordinator.ts). One implementation, so an approval
// from either does exactly the same thing.

export class StageActionError extends Error {
  constructor(
    message: string,
    readonly status: number = 400,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

async function readDoc(relPath: string): Promise<string> {
  try {
    return await fs.readFile(path.join(config.harnessRoot, relPath), 'utf8');
  } catch {
    throw new StageActionError(`${relPath} doesn't exist on disk — write or restore its content before approving.`);
  }
}

export async function approveRequirements(session: SessionRecord): Promise<SessionRecord> {
  if (!session.requirementsPath) throw new StageActionError('no requirements document has been written yet');
  const raw = await readDoc(session.requirementsPath);
  await fs.writeFile(path.join(config.harnessRoot, session.requirementsPath), raw.replace(/^status:\s*\w+/m, 'status: approved'), 'utf8');
  return updateSession(session.id, {
    requirementsStatus: 'approved',
    stage: 'requirements-approved',
    // Approving a single doc keeps the feature as one.
    splitProposal: null,
    // A revision that got here via a mid-coding send-back needs the plan
    // to reconcile against it too before coding resumes — flag Plan to
    // auto-relay the note the moment it's reached.
    ...(session.reopenedFromCoding ? { planRelayPending: true } : {}),
  });
}

export async function approvePlan(session: SessionRecord, options: { ignoreDependencies?: boolean } = {}): Promise<SessionRecord> {
  if (!session.planPath) throw new StageActionError('no plan document has been written yet');

  // A part of a split feature branches off the base branch, so code from
  // a part it builds on is only there once that part has shipped. The
  // human can still go ahead (e.g. they merged it by hand).
  if (!options.ignoreDependencies && !session.branch) {
    const roadmap = await loadSplitRoadmap(session);
    const self = roadmap?.parts.find((p) => p.sessionId === session.id);
    if (roadmap && self && self.blockedBy.length > 0) {
      const waiting = self.blockedBy.map((i) => roadmap.parts[i]);
      throw new StageActionError(
        `This part builds on ${waiting.map((p) => `"${p.title}"`).join(', ')}, which ${waiting.length > 1 ? "haven't" : "hasn't"} ` +
          'shipped yet, so coding would start without that code.',
        409,
        {
          code: 'dependencies_not_shipped',
          blockedBy: waiting.map((p) => ({ sessionId: p.sessionId, title: p.title, sessionKey: p.sessionKey })),
        },
      );
    }
  }

  const raw = await readDoc(session.planPath);
  // Parse with matter so we can update frontmatter properly (adding
  // preambleSummary) while also flipping status to approved.
  const parsed = matter(raw);
  parsed.data.status = 'approved';
  // Compress the preamble (everything before ## Steps) once at approval
  // time. planExcerpt() uses this on every coding hop instead of the full
  // text, saving 5k–10k chars per hop on large plans.
  const stepsIdx = parsed.content.search(/^##\s+(\S+\s+)?steps\b/im);
  if (stepsIdx >= 0) {
    const summary = await tryCompressPlanPreamble(parsed.content.slice(0, stepsIdx)).catch(() => null);
    if (summary) parsed.data.preambleSummary = summary;
  }
  await fs.writeFile(path.join(config.harnessRoot, session.planPath), matter.stringify(parsed.content, parsed.data), 'utf8');

  // A plan re-approved as part of a mid-coding send-back round trip
  // resumes the SAME branch — it jumps straight back to coding-review
  // (skipping plan-approved, which would otherwise wait for the coding
  // stage's own from-scratch kickoff) and flags coding to relay the
  // reconciliation context on its next turn instead of creating a new
  // branch.
  const resuming = session.reopenedFromCoding && Boolean(session.branch);
  return updateSession(session.id, {
    planStatus: 'approved',
    stage: resuming ? 'coding-review' : 'plan-approved',
    ...(resuming ? { codingReconciliationPending: true } : {}),
  });
}

export async function approveCoding(session: SessionRecord): Promise<SessionRecord> {
  if (!session.branch) throw new StageActionError('no commits exist on a branch yet');
  // The coding agent's notes go over with the branch (qa-agent.ts).
  return updateSession(session.id, {
    stage: 'qa-in-progress',
    codingApprovedAt: new Date().toISOString(),
    qaNotes: [],
    qaHandoffNotes: session.qaNotes,
    qaRerunPending: session.transcripts.qa.length > 0,
    fixScope: null,
  });
}

export type QaResult = 'pass' | 'fail' | 'pass-with-notes';

/** The verdict in the QA report's frontmatter, or null without a report. */
export async function readQaResult(session: SessionRecord): Promise<QaResult | null> {
  if (!session.qaReportPath) return null;
  try {
    const result = matter(await fs.readFile(path.join(config.harnessRoot, session.qaReportPath), 'utf8')).data.result;
    return result === 'pass' || result === 'fail' || result === 'pass-with-notes' ? result : null;
  } catch {
    return null;
  }
}

/** Marks QA reviewed. Reaching "done" never pushes, merges or opens an MR by itself — that's deliverSession. */
export async function approveQa(session: SessionRecord): Promise<SessionRecord> {
  if (!session.qaReportPath) throw new StageActionError('no QA report has been written yet');
  if (!qaReportIsCurrent(session)) throw new StageActionError("this QA pass hasn't written its report yet; the one on file is from the last pass");
  const raw = await readDoc(session.qaReportPath);
  await fs.writeFile(path.join(config.harnessRoot, session.qaReportPath), raw.replace(/^status:\s*\S+/m, 'status: reviewed'), 'utf8');
  return updateSession(session.id, { qaStatus: 'reviewed', stage: 'done' });
}

/** What shipping this branch would do, worked out from the repo (repo/delivery.ts). */
export async function planDelivery(session: SessionRecord): Promise<DeliveryPlan> {
  if (!session.branch) throw new StageActionError('no branch to deliver yet');
  const app = await getApp(session.appId);
  return detectDelivery(app.repoRoot, session.branch, await resolveBaseBranch(app.repoRoot, baseBranchFor(app)));
}

/** Merges the reviewed branch locally (no remote) or pushes it and opens an MR/PR. Only after QA is reviewed. */
export async function deliverSession(session: SessionRecord, plan?: DeliveryPlan): Promise<SessionRecord> {
  if (!session.branch) throw new StageActionError('no branch to deliver yet');
  if (session.qaStatus !== 'reviewed') throw new StageActionError('mark QA reviewed before shipping');
  if (isShipped(session.delivery)) {
    throw new StageActionError(`already delivered: ${session.delivery!.detail}`);
  }
  const app = await getApp(session.appId);
  const delivery = plan ?? (await planDelivery(session));
  const text = await buildDeliveryText(session, app.repoRoot, delivery.baseBranch, await sharedBranchFeature(session));
  const result = await deliver(app.repoRoot, delivery, text);
  const updated = await updateSession(session.id, { delivery: result });
  await recordSharedBranchShipped(updated);
  return updated;
}

/** The feature a shared branch ships, when earlier parts were kept on this session's branch. */
async function sharedBranchFeature(session: SessionRecord): Promise<{ title: string; parts: string[] } | undefined> {
  const roadmap = await loadSplitRoadmap(session);
  if (!roadmap || !session.branch) return undefined;
  const onBranch = roadmap.parts.filter(
    (p) => p.sessionId === session.id || (p.delivery?.kind === 'kept' && p.delivery.target === session.branch),
  );
  if (onBranch.length < 2) return undefined;
  return { title: roadmap.parent.title, parts: onBranch.map((p) => p.title) };
}

/** A split part's alternative to shipping: stays on its branch, and the next part continues on it. Only after QA is reviewed. */
export async function keepSessionOnBranch(session: SessionRecord): Promise<SessionRecord> {
  try {
    return await keepOnBranch(session);
  } catch (err) {
    throw new StageActionError(err instanceof Error ? err.message : String(err));
  }
}
