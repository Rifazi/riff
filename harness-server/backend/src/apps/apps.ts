import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Overrides the npm script name run_checked_command uses for each of its
// three fixed checks (see agents/tool-defs/qa-tools.ts's DEFAULT_SCRIPTS) — the
// command set itself stays a closed enum (the tool's actual safety
// mechanism), but which package.json script each one maps to varies by
// repo. Any key left unset falls back to the legacy Customer-EDI default
// (lint -> "lint", test -> "test:ci", test:integration -> "test:integration").
export interface CheckCommands {
  lint?: string;
  test?: string;
  'test:integration'?: string;
}

export interface AppConfig {
  id: string;
  name: string;
  repoRoot: string;
  checkCommands?: CheckCommands;
}

// Fixed id for the app seeded from the legacy single-repo TARGET_REPO_ROOT
// env var, on a harness that predates multi-app support — its prompt
// overrides are seeded from backend/src/agents/prompts/customer-edi-legacy/
// (see settings/prompts-store.ts) so existing behavior is unchanged after
// upgrading. Lives here (not apps-store.ts) so session-store.ts can default
// old sessions' appId to it without an apps-store <-> session-store import
// cycle (apps-store.ts imports session-store.ts for its own in-use check).
export const LEGACY_APP_ID = 'customer-edi';

export class InvalidRepoRootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRepoRootError';
  }
}

// Same check config.ts's old resolveTargetRepoRoot used for the single
// TARGET_REPO_ROOT — now applied per app instead of once at startup.
// Deliberately doesn't check for docs/ — a repo without one yet is
// initialized via ensureDocsDir() below rather than rejected, so adding a
// brand-new app doesn't require hand-creating a docs/ folder first.
export function validateRepoRoot(repoRoot: string): string {
  const resolved = path.resolve(repoRoot.trim());
  if (!existsSync(path.join(resolved, 'package.json'))) {
    throw new InvalidRepoRootError(`${resolved} has no package.json — is this really a repo checkout?`);
  }
  return resolved;
}

export function docsDirFor(app: AppConfig): string {
  return path.join(app.repoRoot, 'docs');
}

export function hasDocsDir(repoRoot: string): boolean {
  return existsSync(path.join(repoRoot, 'docs'));
}

// Creates docs/ (with a starter README so it isn't silently empty) the
// first time an app is pointed at a repo that doesn't have one yet. Called
// from createApp/updateApp — never from the dry-run /api/apps/validate
// check, which must stay read-only. Returns whether it actually created
// anything, so callers can surface that to the user.
export function ensureDocsDir(repoRoot: string): boolean {
  const docsDir = path.join(repoRoot, 'docs');
  if (existsSync(docsDir)) return false;
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(
    path.join(docsDir, 'README.md'),
    '# Docs\n\n' +
      "Markdown files under here are indexed for this app's agents to search via " +
      '`search_docs` — add architecture notes, conventions, and anything else the ' +
      'requirements/plan/coding/QA agents should ground their work in.\n'
  );
  return true;
}

// Read fresh each time rather than stored on the record, so it can never go
// stale if repoRoot is edited later.
export function readRepoUrl(app: AppConfig): string | null {
  try {
    const pkg = JSON.parse(readFileSync(path.join(app.repoRoot, 'package.json'), 'utf8'));
    const url: string | undefined = pkg.repository?.url;
    if (!url) return null;
    return url.replace(/^git\+/, '').replace(/\.git$/, '');
  } catch {
    return null;
  }
}

export function slugifyAppId(input: string): string {
  return (
    input
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'app'
  );
}
