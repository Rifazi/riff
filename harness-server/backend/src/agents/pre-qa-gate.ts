import { baseBranchFor, type AppConfig } from '../apps/apps.js';
import { diffBaseFor } from '../sessions/shared-branch.js';
import { DOMAIN_DOC } from '../architecture/architecture.js';
import { auditWayfinding, branchScope } from '../architecture/wayfinding-audit.js';
import { branchChanges, commitAll, currentBranch, diffWorktreeSince, resolveCommit, withDetachedWorktree } from '../repo/git.js';
import type { SessionRecord } from '../sessions/session.js';
import { createQaExecutors, sessionCheckCache } from './tool-defs/qa-tools.js';
import { fixCheckProblems } from './fix-check.js';
import { fixScopeFor } from './fix-scope.js';
import { blockingAuditProblems, checkSucceeded, gateDetails, gateFingerprint, gateMessage, gateSummary, problemKey, type GateCheck } from './pre-qa-gate-core.js';

export type PreQaGateResult =
  | { status: 'pass'; summary: string }
  // The checks can't run here (no branch, or the checkout is on another
  // branch): QA doesn't run them either, so the branch can't go on.
  | { status: 'skipped'; summary: string }
  | { status: 'fail'; summary: string; message: string; details: string; fingerprint: string[]; auditProblems: string[] };

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
  const head = await resolveCommit(app.repoRoot, 'HEAD');
  const diff = await diffWorktreeSince(app.repoRoot, last.head);
  // Nothing changed at all since that pass: not a fix pass in progress.
  if (!diff.trim() && head === last.head) return [];
  return fixCheckProblems(await fixScopeFor(app.repoRoot, last), diff);
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
  if (fixProblems.length) checks.push({ label: 'fix check', passed: false, output: fixProblems.map((p) => `- ${p}`).join('\n') });

  let auditProblems: string[] = [];
  let regenerated: string[] = [];
  if (app.architecture) {
    const base = diffBaseFor(session, app);
    // Generated Files/Consumers sections are mechanical, so the gate rewrites
    // the stale ones in the domains this branch touched and commits them,
    // instead of sending the coder (or QA) a note about them.
    const first = auditWayfinding(app.repoRoot, app.architecture);
    const touched = await branchChanges(app.repoRoot, base, `:(glob)**/${DOMAIN_DOC}`, session.branch);
    const domains = touched ? new Set(branchScope(first, base, touched.files, touched.docDiff).byDomain.map((d) => d.domain)) : new Set<string>();
    const touchedDirs = first.domains.filter((d) => domains.has(d.id)).map((d) => `${d.dir}/${DOMAIN_DOC}`);
    if (touchedDirs.length) {
      const fixed = auditWayfinding(app.repoRoot, app.architecture, { regenerate: (docPath) => touchedDirs.includes(docPath) });
      regenerated = fixed.regenerated;
      if (regenerated.length) await commitAll(app.repoRoot, 'docs: regenerate DOMAIN.md generated sections', regenerated).catch(() => null);
    }
    const audit = auditWayfinding(app.repoRoot, app.architecture);
    const changes = await branchChanges(app.repoRoot, base, `:(glob)**/${DOMAIN_DOC}`, session.branch);
    const baseline = await baselineProblems(app, base);
    auditProblems = blockingAuditProblems(audit, changes ? branchScope(audit, base, changes.files, changes.docDiff) : null, baseline ?? undefined);
  }

  const summary = gateSummary(checks, auditProblems) + (regenerated.length ? ` (regenerated ${regenerated.length} DOMAIN.md)` : '');
  const message = gateMessage(checks, auditProblems);
  const details = gateDetails(checks, auditProblems);
  return message && details ? { status: 'fail', summary, message, details, fingerprint: gateFingerprint(checks, auditProblems), auditProblems } : { status: 'pass', summary };
}
