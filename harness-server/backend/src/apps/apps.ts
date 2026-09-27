import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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
  // The branch the coding stage branches off and diffs against, detected by
  // repo/git.ts's setupGitRepo() when the app is created or its repoRoot
  // changes. Missing on apps that predate it, which get "master".
  baseBranch?: string;
}

export function baseBranchFor(app: AppConfig): string {
  return app.baseBranch ?? 'master';
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

// Only requires an absolute path to a directory, or to a not-yet-existing
// folder whose parent exists (createApp/updateApp create it), so a brand-new
// app can start from an empty folder. No package.json, docs/ or .git is
// required: docs/ is initialized by ensureDocsDir() below and git by
// repo/git.ts's setupGitRepo(). The absolute-path rule stops a relative path
// silently resolving against the server's own working directory.
export function validateRepoRoot(repoRoot: string): string {
  const trimmed = repoRoot.trim();
  if (!path.isAbsolute(trimmed)) {
    throw new InvalidRepoRootError(`"${trimmed}" is not an absolute path.`);
  }
  const resolved = path.resolve(trimmed);
  if (existsSync(resolved)) {
    if (!statSync(resolved).isDirectory()) throw new InvalidRepoRootError(`${resolved} is a file, not a folder.`);
    return resolved;
  }
  if (!existsSync(path.dirname(resolved)) || !statSync(path.dirname(resolved)).isDirectory()) {
    throw new InvalidRepoRootError(`${resolved} doesn't exist, and neither does its parent folder.`);
  }
  return resolved;
}

// What the read-only /api/apps/validate check tells the user setup will do.
export function describeSetup(repoRoot: string): string | undefined {
  if (!existsSync(repoRoot)) return 'This folder will be created, with git initialized and a docs/ folder.';
  const notes: string[] = [];
  if (!existsSync(path.join(repoRoot, '.git'))) notes.push('git will be initialized with an initial commit');
  if (!hasDocsDir(repoRoot)) notes.push('a docs/ folder will be created');
  if (notes.length === 0) return undefined;
  const sentence = notes.join(' and ');
  return `${sentence[0].toUpperCase()}${sentence.slice(1)}.`;
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
  mkdirSync(repoRoot, { recursive: true });
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
