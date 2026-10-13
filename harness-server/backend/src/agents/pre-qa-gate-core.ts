import type { BranchScope, WayfindingAudit } from '../architecture/wayfinding-audit.js';

/**
 * The pre-QA gate's pure half: what counts as a failure and what the coding
 * lead is told. The gate runs before the coordinator approves coding, so a
 * branch whose lint, unit tests or Wayfinding audit fail goes back to the
 * lead (one turn, failing output only) instead of costing a QA round.
 */

export interface GateCheck {
  label: string;
  passed: boolean;
  // What the lead sees for a failed check (run_checked_command's report).
  output: string;
}

/**
 * Whether run_checked_command's report says the script passed. Its status line
 * ("<script> succeeded." / "<script> failed.") can follow install notes, so
 * it isn't always the first line.
 */
export function checkSucceeded(output: string): boolean {
  const status = output.split('\n').find((l) => /^\S+ (?:succeeded|failed)\b/.test(l));
  return Boolean(status && /^\S+ succeeded\b/.test(status));
}

/**
 * The audit problems this branch is answerable for: problems in MAP.md or in
 * domains it touched, and changed code in folders with no DOMAIN.md. Problems
 * in untouched domains are pre-existing and don't hold the branch back (QA
 * doesn't fail it for them either).
 */
export function blockingAuditProblems(audit: WayfindingAudit, scope: BranchScope | null): string[] {
  const touched = scope ? new Set(scope.byDomain.map((d) => d.domain)) : null;
  const lines = audit.problems
    .filter((p) => !touched || p.domain === null || touched.has(p.domain))
    .map((p) => `[${p.kind}] ${p.message.startsWith(p.file) ? p.message : `${p.file}: ${p.message}`}`);
  for (const o of scope?.offMap ?? []) {
    lines.push(`[map] ${o.folder}/ has changed code but no DOMAIN.md (${o.parent ? `child domain of ${o.parent}` : 'top-level domain, add it to MAP.md'})`);
  }
  return lines;
}

const MAX_AUDIT_LINES = 25;

/** The message the lead gets, or null when every check passed. */
export function gateMessage(checks: GateCheck[], auditProblems: string[]): string | null {
  const failed = checks.filter((c) => !c.passed);
  if (!failed.length && !auditProblems.length) return null;
  const parts = [
    'Before QA, I ran the checks QA runs on this branch, and they fail. Fix these on the branch and commit, then stop: ' +
      "QA starts once they pass. Don't assign a team for this, and don't leave a note asking QA to run or fix them.",
  ];
  for (const c of failed) parts.push(`## ${c.label}\n\n${c.output.trim()}`);
  if (auditProblems.length) {
    const shown = auditProblems.slice(0, MAX_AUDIT_LINES).map((l) => `- ${l}`);
    if (auditProblems.length > MAX_AUDIT_LINES) shown.push(`- … ${auditProblems.length - MAX_AUDIT_LINES} more (run audit_architecture)`);
    parts.push(
      `## audit_architecture (${auditProblems.length} problem(s) on this branch)\n\n${shown.join('\n')}\n\n` +
        'Stale generated Files/Consumers sections are fixed by audit_architecture({ regenerate: true }), never by hand.'
    );
  }
  return parts.join('\n\n');
}

/** One line for the coordinator's decision, e.g. "lint, audit (3) failed". */
export function gateSummary(checks: GateCheck[], auditProblems: string[]): string {
  const failed = checks.filter((c) => !c.passed).map((c) => c.label);
  if (auditProblems.length) failed.push(`audit (${auditProblems.length})`);
  return failed.length ? `${failed.join(', ')} failed` : 'lint, tests and audit pass';
}
