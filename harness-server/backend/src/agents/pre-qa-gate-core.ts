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
 * domains it touched, and changed code in folders with no README.md. Problems
 * in untouched domains are pre-existing and don't hold the branch back (QA
 * doesn't fail it for them either).
 */
export function problemKey(p: { kind: string; file: string; message: string }): string {
  return `${p.kind}|${p.file}|${p.message.replace(/\s+/g, ' ').trim()}`;
}

/**
 * `baseline` = the keys of problems the base branch already has: they aren't
 * this branch's doing, so they never hold it back.
 */
export function blockingAuditProblems(audit: WayfindingAudit, scope: BranchScope | null, baseline?: ReadonlySet<string>): string[] {
  const touched = scope ? new Set(scope.byDomain.map((d) => d.domain)) : null;
  const lines = audit.problems
    .filter((p) => !baseline?.has(problemKey(p)))
    .filter((p) => !touched || p.domain === null || touched.has(p.domain))
    .map((p) => `[${p.kind}] ${p.message.startsWith(p.file) ? p.message : `${p.file}: ${p.message}`}`);
  for (const o of scope?.offMap ?? []) {
    lines.push(`[map] ${o.folder}/ has changed code but no README.md (${o.parent ? `child domain of ${o.parent}` : 'top-level domain, add it to MAP.md'})`);
  }
  for (const f of scope?.looseFiles ?? []) {
    lines.push(`[map] ${f} is loose in a source folder: move it into the subfolder of the domain that owns it (only index/main/app/server/cli may sit there)`);
  }
  return lines;
}

/**
 * The doc paths a requirements document's "Docs to update" section lists: the
 * first path-like token of each bullet (backticked or bare, with a file
 * extension). A bullet that says "none" or names no path lists nothing.
 */
export function docsToUpdate(requirements: string): string[] {
  const lines = requirements.split('\n');
  const start = lines.findIndex((l) => /^#{1,6}\s+docs to update\s*$/i.test(l.trim()));
  if (start < 0) return [];
  const paths: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(line)) break;
    const bullet = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)$/);
    if (!bullet) continue;
    const token = bullet[1].match(/`([^`\s]+\.[A-Za-z0-9]+)`/) ?? bullet[1].match(/^\*{0,2}([^\s`*:,;()]+\.[A-Za-z0-9]+)/);
    if (token) paths.push(token[1].replace(/^\.\//, '').replace(/[.,;:]+$/, ''));
  }
  return [...new Set(paths)];
}

/** The listed docs the branch didn't change (a listed path matches a changed file by its full path or as a trailing part of it). */
export function untouchedDocs(listed: readonly string[], changedFiles: readonly string[]): string[] {
  return listed.filter((doc) => !changedFiles.some((f) => f === doc || f.endsWith(`/${doc}`)));
}

/** The check's output for the lead, one line per doc. */
export function docsCheckOutput(untouched: readonly string[]): string {
  return (
    untouched.map((d) => `- ${d} is in the requirements' "Docs to update" but this branch doesn't change it`).join('\n') +
    '\n\nUpdate each one for what this branch changed and commit. If a doc really needs no change, say why with note_for_qa.'
  );
}

const MAX_AUDIT_LINES = 25;

/** The failing output, one section per failed check and one for the audit problems; null when every check passed. */
export function gateDetails(checks: GateCheck[], auditProblems: string[]): string | null {
  const failed = checks.filter((c) => !c.passed);
  if (!failed.length && !auditProblems.length) return null;
  const parts: string[] = [];
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

/** The message the lead gets, or null when every check passed. */
export function gateMessage(checks: GateCheck[], auditProblems: string[]): string | null {
  const details = gateDetails(checks, auditProblems);
  if (!details) return null;
  return (
    "Before QA, I ran lint and the unit tests and checked the requirements' docs list and the branch's scope, and something fails. Fix these on the branch and commit, then stop: " +
    "QA starts once they pass, and QA doesn't run them itself. Don't assign a team for this, and don't leave a note asking QA to run or fix them.\n\n" +
    details
  );
}

/** One line for the coordinator's decision, e.g. "lint, audit (3) failed". */
export function gateSummary(checks: GateCheck[], auditProblems: string[]): string {
  const failed = checks.filter((c) => !c.passed).map((c) => c.label);
  if (auditProblems.length) failed.push(`audit (${auditProblems.length})`);
  return failed.length ? `${failed.join(', ')} failed` : 'lint, tests and audit pass';
}

/** What is failing, one entry per failed check and audit problem, to tell whether a fix pass changed anything. */
export function gateFingerprint(checks: GateCheck[], auditProblems: string[]): string[] {
  return [...checks.filter((c) => !c.passed).map((c) => `check:${c.label}`), ...auditProblems].sort();
}

/** A fix pass that leaves exactly the same things failing made no progress; asking again would repeat it. */
export function gateStuck(previous: readonly string[] | null | undefined, now: readonly string[]): boolean {
  if (!previous?.length || previous.length !== now.length) return false;
  const before = new Set(previous);
  return now.every((item) => before.has(item));
}

/**
 * The lead's message for a fix pass after the first. A pass that left the same
 * things failing gets told so, and told to find out why instead of repeating it.
 */
export function gateRetryMessage(message: string, pass: number, stuck: boolean): string {
  if (!stuck) return message;
  return (
    `Fix attempt ${pass + 1}: your last pass left exactly the same things failing, so what you changed didn't address them. ` +
    'Do not repeat it. For each failure below, run the check or audit_architecture yourself, read the exact output, and work out why it still fails ' +
    '(a stale generated section needs audit_architecture({ regenerate: true }); a missing README.md has to be created and committed; ' +
    'a problem in code you did not touch is not yours, so say so with note_for_qa). Commit the fix and confirm the check passes before you stop.\n\n' +
    message
  );
}

export function gateStopReason(summary: string, auditProblems: string[], why: 'stuck' | 'limit', passes: number): string {
  const lead =
    why === 'stuck'
      ? `The coding lead's last fix pass left the pre-QA checks failing in exactly the same way (${summary}).`
      : `Pre-QA checks still fail after ${passes} fix passes (${summary}).`;
  const shown = auditProblems.slice(0, 6).map((l) => `- ${l.length > 220 ? `${l.slice(0, 217)}…` : l}`);
  if (auditProblems.length > shown.length) shown.push(`- … ${auditProblems.length - shown.length} more`);
  return `${lead}${shown.length ? `\n\nArchitecture audit:\n${shown.join('\n')}` : ''}\n\nOver to you.`;
}
