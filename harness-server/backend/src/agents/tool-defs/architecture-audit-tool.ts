import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { baseBranchFor, type AppConfig } from '../../apps/apps.js';
import { DOMAIN_DOC } from '../../architecture/architecture.js';
import { auditWayfinding, branchScope, formatWayfindingAudit } from '../../architecture/wayfinding-audit.js';
import { branchChanges, withinPaths } from '../../repo/git.js';

export const auditArchitectureSchema = z.object({
  regenerate: z
    .boolean()
    .optional()
    .describe('Rewrite the generated Files and Consumers sections of every DOMAIN.md from the code before reporting (never edit them by hand)'),
});
export const auditArchitectureReadOnlySchema = z.object({});

const BASE_DESCRIPTION =
  "Run this app's Wayfinding Architecture checks and list its domains (from MAP.md and each DOMAIN.md). Reports: imports " +
  "of another domain's private files, child domains reached from outside their parent, children depending on their parent, " +
  'dependency cycles, rules without an existing "Enforced by" test, rules in two domains, Recipes naming missing files, ' +
  'stale generated Files and Consumers sections, top-level domains missing from MAP.md, and (with TypeORM) tables without one owner. ';

export interface AuditArchitectureDeps {
  app: AppConfig;
  // The checkout to audit: the app's repo, or a team member's worktree.
  repoRoot: string;
  // Report which domains the branch touched (coding and QA, once a branch exists).
  scope: boolean;
  // The branch to compare, when it may not be the one checked out (QA).
  branch?: string;
  // What the branch is compared against: where a part of a shared branch
  // started, else the app's base branch.
  baseBranch?: string;
  allowRegenerate: boolean;
  // A team member regenerates only the DOMAIN.md files inside its owned paths.
  writablePaths?: string[];
}

export function auditArchitectureDescription(deps: Pick<AuditArchitectureDeps, 'scope' | 'allowRegenerate'>): string {
  return (
    BASE_DESCRIPTION +
    (deps.scope ? 'Also lists the domains this branch touched and any ownership or structural edits to DOMAIN.md files. ' : '') +
    (deps.allowRegenerate ? 'regenerate: true rewrites the generated Files and Consumers sections. ' : 'Read-only. ') +
    'Run it before planning or changing code in a domain, and again before finishing.'
  );
}

// Every call's result stays in the conversation and is re-sent on each later
// request (one turn paid for 6 audits of ~24k chars each), so a result is
// capped, a repeat of the last one is a note, and the domain list, which
// doesn't change within a turn, comes back only the first time.
const AUDIT_CHAR_LIMIT = 10_000;

export function trimAudit(text: string, previous: string | null): string {
  if (text === previous) return 'The audit result is unchanged since your last call: the same problems remain. Fix them, then audit again.';
  let out = text;
  if (previous !== null) {
    out = out.replace(/\n\nDomains:\n(?:- .*\n?)+/, '\n\n(Domain list as in your first audit.)\n');
    if (previous.includes('\n  Give each one a DOMAIN.md')) {
      out = out.replace(/\n  Give each one a DOMAIN\.md[^\n]*/, '\n  (How to give each folder a DOMAIN.md: as in your earlier audit.)');
    }
    const scopeBlock = /\n\nBranch scope \(vs [^)]*\):\n(?:- .*\n?)+/;
    const scopeNow = out.match(scopeBlock)?.[0].trimEnd();
    if (scopeNow && scopeNow === previous.match(scopeBlock)?.[0].trimEnd()) out = out.replace(scopeBlock, '\n\n(Branch scope: unchanged since your last audit.)\n');
  }
  if (out.length <= AUDIT_CHAR_LIMIT) return out;
  const cut = out.lastIndexOf('\n', AUDIT_CHAR_LIMIT);
  return `${out.slice(0, cut > 0 ? cut : AUDIT_CHAR_LIMIT)}\n[… ${out.length - AUDIT_CHAR_LIMIT} more characters cut: fix what is listed, then audit again for the rest]`;
}

export function createAuditArchitectureExecute(deps: AuditArchitectureDeps) {
  let previous: string | null = null;
  return async (input: { regenerate?: boolean }): Promise<string> => {
    const config = deps.app.architecture;
    if (!config) return "This app doesn't follow an architecture any more; there is nothing to audit.";
    const wanted = Boolean(input?.regenerate) && deps.allowRegenerate;
    const writable = deps.writablePaths;
    const regenerate = wanted && writable ? (docPath: string) => withinPaths(docPath, writable) : wanted;
    const audit = auditWayfinding(deps.repoRoot, config, { regenerate });
    let scope = null;
    if (deps.scope) {
      const base = deps.baseBranch ?? baseBranchFor(deps.app);
      const changes = await branchChanges(deps.repoRoot, base, `:(glob)**/${DOMAIN_DOC}`, deps.branch);
      if (changes) scope = branchScope(audit, base, changes.files, changes.docDiff);
    }
    const full = formatWayfindingAudit(audit, scope, { compact: true });
    const shown = trimAudit(full, previous);
    previous = full;
    return shown;
  };
}

export function createAuditArchitectureTool(deps: AuditArchitectureDeps) {
  return tool({
    description: auditArchitectureDescription(deps),
    inputSchema: deps.allowRegenerate ? auditArchitectureSchema : auditArchitectureReadOnlySchema,
    execute: createAuditArchitectureExecute(deps),
  });
}

/**
 * The tool for an AI-SDK turn: registered when the app follows an
 * architecture, and kept for a replayed history that called it after the
 * setting was turned off (its execute then says so), like delegate.
 */
export function architectureToolEntry(deps: AuditArchitectureDeps, history: unknown[] = []): ToolSet {
  if (!deps.app.architecture && !JSON.stringify(history).includes('"toolName":"audit_architecture"')) return {};
  return { audit_architecture: createAuditArchitectureTool(deps) };
}
