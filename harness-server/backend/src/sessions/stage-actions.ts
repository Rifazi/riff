import { randomUUID } from 'node:crypto';
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
import { runPreQaGate } from '../agents/pre-qa-gate.js';
import { runVisualGate } from '../agents/visual-review.js';
import { visualFixMessage } from '../agents/visual-review-core.js';
import { scheduleRetrospective } from '../retrospective/service.js';

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

/**
 * Every way into QA ends here, so QA never runs lint or the unit tests: they
 * pass on this branch first, or it stays in coding. A refusal carries the
 * failing output as `fixMessage`, which the caller can hand to the coding
 * lead (the coordinator does, up to its send-back limit).
 */
const approvalEpoch = new Map<string, number>();

/** A send-back during the pre-QA gate's run would otherwise be undone when the gate finishes and approves. */
export function cancelPendingApproval(sessionId: string): void {
  approvalEpoch.set(sessionId, (approvalEpoch.get(sessionId) ?? 0) + 1);
}

export async function approveCoding(session: SessionRecord): Promise<SessionRecord> {
  if (!session.branch) throw new StageActionError('no commits exist on a branch yet');
  const epoch = approvalEpoch.get(session.id) ?? 0;
  let gate;
  try {
    gate = await runPreQaGate(session, await getApp(session.appId));
  } catch (err) {
    throw new StageActionError(`Lint and the unit tests couldn't be run before QA: ${err instanceof Error ? err.message : String(err)}`, 409);
  }
  if (gate.status === 'skipped') throw new StageActionError(`Lint and the unit tests can't be run before QA: ${gate.summary}.`, 409);
  if (gate.status === 'fail') {
    throw new StageActionError(`Can't start QA yet: ${gate.summary}. The coding lead is being sent the failures to fix.\n\n${gate.details}`, 409, {
      code: 'checks_failed',
      fixMessage: gate.message,
      details: gate.details,
    });
  }
  if ((approvalEpoch.get(session.id) ?? 0) !== epoch) {
    throw new StageActionError('The session was sent back to coding while the checks ran, so it was not sent to QA.', 409);
  }
  // A branch that changes the UI is screenshotted, judged by the UI/UX agent and signed off by the human first.
  const app = await getApp(session.appId);
  const visual = await runVisualGate(session, app).catch((err) => {
    throw new StageActionError(`The visual review couldn't run: ${err instanceof Error ? err.message : String(err)}`, 409);
  });
  if (visual.status === 'changes-needed') {
    throw new StageActionError(`The UI/UX agent wants changes before QA: ${visual.review.summary} The coding lead is being sent the findings.`, 409, {
      code: 'visual_changes_needed',
      fixMessage: visual.message,
    });
  }
  if (visual.status === 'awaiting-human') {
    throw new StageActionError('The screenshots are ready for your approval. Review them on the Coding tab to start QA.', 409, { code: 'visual_review_pending' });
  }
  if ((approvalEpoch.get(session.id) ?? 0) !== epoch) {
    throw new StageActionError('The session was sent back to coding while the visual review ran, so it was not sent to QA.', 409);
  }
  // The coding agent's notes go over with the branch (qa-agent.ts).
  return updateSession(session.id, {
    stage: 'qa-in-progress',
    codingApprovedAt: new Date().toISOString(),
    qaNotes: [],
    qaHandoffNotes: [
      ...session.qaNotes,
      ...(gate.status === 'pass' && gate.advisory?.length
        ? [{
            id: randomUUID(),
            from: null,
            text: `The pre-QA fix check could not confirm these blockers were fixed (the coder was told once and the branch went on): ${gate.advisory.join(' ')} Verify them in the code yourself.`,
            at: new Date().toISOString(),
          }]
        : []),
    ],
    qaRerunPending: session.transcripts.qa.length > 0,
    fixScope: null,
  });
}

/** The human signs off the screenshots the UI/UX agent passed, and QA starts. */
export async function approveVisualReview(session: SessionRecord): Promise<SessionRecord> {
  const review = session.visualReview;
  if (review?.status !== 'awaiting-human') throw new StageActionError('there are no screenshots waiting for approval');
  const approved = await updateSession(session.id, { visualReview: { ...review, status: 'approved', approvedAt: new Date().toISOString() } });
  return approveCoding(approved);
}

/** The human wants changes: returns the message that sends the coding lead back to fix them. */
export async function requestVisualChanges(session: SessionRecord, note: string): Promise<{ session: SessionRecord; fixMessage: string }> {
  const review = session.visualReview;
  if (review?.status !== 'awaiting-human') throw new StageActionError('there are no screenshots waiting for approval');
  if (!note.trim()) throw new StageActionError('say what needs to change');
  const next = { ...review, status: 'changes-requested' as const, humanNote: note.trim(), agentRounds: 0 };
  return { session: await updateSession(session.id, { visualReview: next }), fixMessage: visualFixMessage(next, 'human') };
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

/**
 * Reopens coding with this pass's QA findings (the human's "Send back for
 * fixes", and Bridget's reaction to a failed pass). The report and QA chat
 * stay as the record; a fresh pass starts when coding is approved again.
 */
export async function sendBackToCoding(session: SessionRecord, declinedNotes: string[] = []): Promise<SessionRecord> {
  if (isShipped(session.delivery)) throw new StageActionError(`already delivered: ${session.delivery!.detail}`);
  cancelPendingApproval(session.id);
  if (session.qaStatus === 'reviewed' && session.qaReportPath) {
    const filePath = path.join(config.harnessRoot, session.qaReportPath);
    const raw = await fs.readFile(filePath, 'utf8');
    await fs.writeFile(filePath, raw.replace(/^status:\s*\S+/m, 'status: pending-review'), 'utf8');
  }
  // The team that built what QA reviewed is done: it moves to history so the fix pass starts with Jack alone.
  const retireTeam = session.codingTeam && session.codingTeam.status !== 'assigned';
  return updateSession(session.id, {
    codingApprovedAt: null,
    ...(session.delivery?.kind === 'kept' && { delivery: null }),
    stage: 'coding-review',
    // A report from an earlier pass would send the coder findings it may already have fixed.
    qaFindingsPending: qaReportIsCurrent(session),
    qaSendBackAt: new Date().toISOString(),
    qaDeclinedNotes: declinedNotes,
    qaStatus: session.qaStatus === 'reviewed' ? 'pending-review' : session.qaStatus,
    ...(retireTeam && { codingTeam: null, codingTeamHistory: [...session.codingTeamHistory, session.codingTeam!] }),
  });
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
  scheduleRetrospective(updated);
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
    const kept = await keepOnBranch(session);
    scheduleRetrospective(kept);
    return kept;
  } catch (err) {
    throw new StageActionError(err instanceof Error ? err.message : String(err));
  }
}
