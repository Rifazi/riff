import { baseBranchFor, type AppConfig } from '../apps/apps.js';
import { diffBaseFor } from '../sessions/shared-branch.js';
import { DOMAIN_DOC } from '../architecture/architecture.js';
import { auditWayfinding, branchScope } from '../architecture/wayfinding-audit.js';
import { branchChanges, currentBranch } from '../repo/git.js';
import type { SessionRecord } from '../sessions/session.js';
import { createQaExecutors, sessionCheckCache } from './tool-defs/qa-tools.js';
import { blockingAuditProblems, checkSucceeded, gateMessage, gateSummary, type GateCheck } from './pre-qa-gate-core.js';

export type PreQaGateResult =
  | { status: 'pass'; summary: string }
  // The checks can't run here (no branch, or the checkout is on another
  // branch): the coordinator approves as before and QA runs them.
  | { status: 'skipped'; summary: string }
  | { status: 'fail'; summary: string; message: string };

/**
 * Runs what QA would fail the branch for first — lint, the unit tests and,
 * for a Wayfinding app, the branch's audit problems — in the session's
 * checkout. No model is involved unless the runner helper (local Qwen)
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

  let auditProblems: string[] = [];
  if (app.architecture) {
    const audit = auditWayfinding(app.repoRoot, app.architecture);
    const base = diffBaseFor(session, app);
    const changes = await branchChanges(app.repoRoot, base, `:(glob)**/${DOMAIN_DOC}`, session.branch);
    auditProblems = blockingAuditProblems(audit, changes ? branchScope(audit, base, changes.files, changes.docDiff) : null);
  }

  const summary = gateSummary(checks, auditProblems);
  const message = gateMessage(checks, auditProblems);
  return message ? { status: 'fail', summary, message } : { status: 'pass', summary };
}
