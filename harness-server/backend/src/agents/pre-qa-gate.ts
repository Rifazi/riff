import fs from 'node:fs';
import path from 'node:path';
import { baseBranchFor, type AppConfig } from '../apps/apps.js';
import { diffBaseFor } from '../sessions/shared-branch.js';
import { DOMAIN_DOC } from '../architecture/architecture.js';
import { auditWayfinding, branchScope } from '../architecture/wayfinding-audit.js';
import { outOfPlan, scopeCheckOutput } from './scope-check.js';
import { branchAddedFiles, branchChanges, commitAll, currentBranch, diffWorktreeSince, resolveCommit, withDetachedWorktree } from '../repo/git.js';
import type { SessionRecord } from '../sessions/session.js';
import { createQaExecutors, sessionCheckCache } from './tool-defs/qa-tools.js';
import { config } from '../config.js';
import { fixCheckProblems } from './fix-check.js';
import { fixScopeFor } from './fix-scope.js';
import { blockingAuditProblems, checkSucceeded, docsCheckOutput, docsToUpdate, untouchedDocs, gateDetails, gateFingerprint, gateMessage, gateSummary, problemKey, type GateCheck } from './pre-qa-gate-core.js';

export type PreQaGateResult =
  // `advisory`: fix-check problems the coder was already told about once; QA gets them as a note instead of the branch being held.
  | { status: 'pass'; summary: string; advisory?: string[] }
  // The checks can't run here (no branch, or the checkout is on another
  // branch): QA doesn't run them either, so the branch can't go on.
  | { status: 'skipped'; summary: string }
  | { status: 'fail'; summary: string; message: string; details: string; fingerprint: string[]; auditProblems: string[] };

// How many times the fix check has held a QA pass's fix back. It can't tell a
// fix that is wrong from one it can't see (a revert the formatter undid, a
// blocker fixed somewhere QA didn't name), so it asks once and then hands what
// is left to QA, who looks at the real code, instead of holding the branch.
const fixCheckHolds = new Map<string, number>();
const MAX_FIX_CHECK_HOLDS = 1;

// How many times the docs check has held a session's branch back: a doc the
// requirements list may truly need no change, so it asks once and QA gets the rest.
const docsCheckHolds = new Map<string, number>();

/** The docs the requirements say to update that the branch doesn't touch. */
async function untouchedRequiredDocs(session: SessionRecord, app: AppConfig): Promise<string[]> {
  if (!session.requirementsPath || !session.branch) return [];
  const raw = fs.readFileSync(path.join(config.harnessRoot, session.requirementsPath), 'utf8');
  const listed = docsToUpdate(raw);
  if (!listed.length) return [];
  const changes = await branchChanges(app.repoRoot, diffBaseFor(session, app), ':(glob)**/*.md', session.branch);
  return changes ? untouchedDocs(listed, changes.files) : [];
}

const scopeCheckHolds = new Map<string, number>();

/** Work the branch did that the requirements and plan never mention; null when none or when it can't be told. */
async function outOfPlanWork(session: SessionRecord, app: AppConfig): Promise<ReturnType<typeof outOfPlan>> {
  if (!session.branch || !session.planPath || !session.requirementsPath) return null;
  const read = (rel: string) => fs.readFileSync(path.join(config.harnessRoot, rel), 'utf8');
  const planText = `${read(session.requirementsPath)}\n${read(session.planPath)}`;
  const base = diffBaseFor(session, app);
  const [changes, added] = await Promise.all([
    branchChanges(app.repoRoot, base, ':(glob)**/*.md', session.branch),
    branchAddedFiles(app.repoRoot, base, session.branch),
  ]);
  return changes && added ? outOfPlan(changes.files, added, planText) : null;
}

const baselineCache = new Map<string, Set<string>>();

/** The audit problems the base branch already has, cached per commit. Null when it can't be read. */
async function baselineProblems(app: AppConfig, base: string): Promise<Set<string> | null> {
  if (!app.architecture) return null;
  try {
    const sha = await resolveCommit(app.repoRoot, base);
    const key = `${app.repoRoot}@${sha}@${JSON.stringify(app.architecture)}`;
    const hit = baselineCache.get(key);
    if (hit) return hit;
    const keys = await withDetachedWorktree(app.repoRoot, sha, async (dir) => new Set(auditWayfinding(dir, app.architecture!).problems.map(problemKey)));
    baselineCache.clear();
    baselineCache.set(key, keys);
    return keys;
  } catch {
    return null;
  }
}

/** On a QA fix pass: whether the changes since QA's last pass reach the lines its blockers name. */
async function qaFixProblems(session: SessionRecord, app: AppConfig): Promise<string[]> {
  const last = session.qaRounds?.[session.qaRounds.length - 1];
  if (!last?.head || last.blocking.length === 0) return [];
  const diff = await diffWorktreeSince(app.repoRoot, last.head);
  return fixCheckProblems(
    await fixScopeFor(app.repoRoot, last),
    diff,
    session.qaNotes.map((n) => n.text),
    (session.qaResponses ?? []).filter((r) => r.pass === last.pass),
  );
}

/**
 * Runs what has to pass before QA — lint, the unit tests and, for a
 * Wayfinding app, the branch's audit problems — in the session's checkout.
 * `approveCoding` calls it, so no route reaches QA around it. No model is involved unless the runner helper (local Qwen)
 * shortens a long failing log.
 */
export async function runPreQaGate(session: SessionRecord, app: AppConfig): Promise<PreQaGateResult> {
  if (!session.branch) return { status: 'skipped', summary: 'no branch yet' };
  const checkedOut = await currentBranch(app.repoRoot).catch(() => null);
  if (checkedOut !== session.branch) {
    return { status: 'skipped', summary: `the checkout is on ${checkedOut ?? 'an unknown branch'}, not ${session.branch}` };
  }

  const { runCheckedCommandExecute } = createQaExecutors({
    repoRoot: app.repoRoot,
    baseBranch: diffBaseFor(session, app),
    checkCommands: app.checkCommands,
    helperContext: { sessionId: session.id, stage: 'coding', record: async () => {} },
    checkCache: sessionCheckCache(session.id),
    checkRunBy: 'the pre-QA checks',
    reuseChecks: true,
  });
  // One after the other: they share the checkout's junit.xml.
  const checks: GateCheck[] = [];
  for (const [command, label] of [['lint', 'lint'], ['test', 'unit tests']] as const) {
    let output: string;
    try {
      output = await runCheckedCommandExecute({ command });
    } catch (err) {
      output = `${command} failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    checks.push({ label, passed: checkSucceeded(output), output });
  }

  const fixProblems = await qaFixProblems(session, app).catch(() => [] as string[]);
  let advisory: string[] = [];
  if (fixProblems.length) {
    const key = `${session.id}:${session.qaRounds?.[session.qaRounds.length - 1]?.pass ?? 0}`;
    const holds = fixCheckHolds.get(key) ?? 0;
    if (holds < MAX_FIX_CHECK_HOLDS) {
      fixCheckHolds.set(key, holds + 1);
      checks.push({ label: 'fix check', passed: false, output: fixProblems.map((p) => `- ${p}`).join('\n') });
    } else {
      advisory = fixProblems;
    }
  }

  const missingDocs = await untouchedRequiredDocs(session, app).catch(() => [] as string[]);
  if (missingDocs.length) {
    const holds = docsCheckHolds.get(session.id) ?? 0;
    if (holds < 1) {
      docsCheckHolds.set(session.id, holds + 1);
      checks.push({ label: 'docs to update', passed: false, output: docsCheckOutput(missingDocs) });
    } else {
      advisory = [...advisory, ...missingDocs.map((d) => `${d} is in "Docs to update" but the branch doesn't change it`)];
    }
  }

  const drift = await outOfPlanWork(session, app).catch(() => null);
  if (drift) {
    const holds = scopeCheckHolds.get(session.id) ?? 0;
    if (holds < 1) {
      scopeCheckHolds.set(session.id, holds + 1);
      checks.push({ label: 'scope', passed: false, output: scopeCheckOutput(drift) });
    } else {
      advisory = [...advisory, ...drift.newDomains.map((d) => `${d}/ is a new domain the requirements and plan don't mention`)];
    }
  }

  let auditProblems: string[] = [];
  let regenerated: string[] = [];
  if (app.architecture) {
    const base = diffBaseFor(session, app);
    // Generated Files/Consumers sections are mechanical, so the gate rewrites
    // the stale ones in the domains this branch touched and commits them,
    // instead of sending the coder (or QA) a note about them.
    // Any domain's generated sections can go stale from this branch's edits
    // (a Consumers list changes when another domain's imports do), so every
    // domain is regenerated, not only the ones whose DOMAIN.md the branch
    // touched. Only generated sections are rewritten.
    const fixed = auditWayfinding(app.repoRoot, app.architecture, { regenerate: true });
    regenerated = fixed.regenerated;
    if (regenerated.length) await commitAll(app.repoRoot, 'docs: regenerate DOMAIN.md generated sections', regenerated).catch(() => null);
    const audit = auditWayfinding(app.repoRoot, app.architecture);
    const changes = await branchChanges(app.repoRoot, base, `:(glob)**/${DOMAIN_DOC}`, session.branch);
    const baseline = await baselineProblems(app, base);
    const scope = changes ? branchScope(audit, base, changes.files, changes.docDiff) : null;
    // Second guard: a folder or file that isn't on disk can't be fixed by the lead, so it never holds the branch back.
    if (scope) {
      scope.offMap = scope.offMap.filter((o) => fs.existsSync(path.join(app.repoRoot, o.folder)));
      scope.looseFiles = scope.looseFiles.filter((f) => fs.existsSync(path.join(app.repoRoot, f)));
    }
    auditProblems = blockingAuditProblems(audit, scope, baseline ?? undefined);
  }

  const summary = gateSummary(checks, auditProblems) + (regenerated.length ? ` (regenerated ${regenerated.length} DOMAIN.md)` : '');
  const message = gateMessage(checks, auditProblems);
  const details = gateDetails(checks, auditProblems);
  return message && details ? { status: 'fail', summary, message, details, fingerprint: gateFingerprint(checks, auditProblems), auditProblems } : { status: 'pass', summary, ...(advisory.length ? { advisory } : {}) };
}
