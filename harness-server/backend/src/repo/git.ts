import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { simpleGit, type SimpleGit } from 'simple-git';

// The base branch for apps created before base branches were per-app (see
// AppConfig.baseBranch), and for brand-new repos setupGitRepo() initializes.
const DEFAULT_BASE_BRANCH = 'master';

export class GitPreconditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitPreconditionError';
  }
}

function client(repoRoot: string): SimpleGit {
  return simpleGit(repoRoot);
}

export async function currentBranch(repoRoot: string): Promise<string> {
  const status = await client(repoRoot).status();
  return status.current ?? '';
}

export async function assertCleanBaseForNewBranch(repoRoot: string, baseBranch = DEFAULT_BASE_BRANCH): Promise<void> {
  const git = client(repoRoot);
  const status = await git.status();
  if (status.current !== baseBranch) {
    throw new GitPreconditionError(
      `Working tree is on "${status.current}", not "${baseBranch}". Switch to a clean ${baseBranch} before starting the coding stage.`
    );
  }
  if (!status.isClean()) {
    throw new GitPreconditionError(
      `${baseBranch} has uncommitted changes. Commit or stash them before starting the coding stage.`
    );
  }
}

export async function createBranch(repoRoot: string, branchName: string, baseBranch = DEFAULT_BASE_BRANCH): Promise<void> {
  await assertCleanBaseForNewBranch(repoRoot, baseBranch);
  const git = client(repoRoot);
  const existing = await git.branchLocal();
  if (existing.all.includes(branchName)) {
    throw new GitPreconditionError(`Branch ${branchName} already exists.`);
  }
  await git.checkoutLocalBranch(branchName);
}

export async function assertOnBranch(repoRoot: string, expectedBranch: string): Promise<void> {
  const current = await currentBranch(repoRoot);
  if (current !== expectedBranch) {
    throw new GitPreconditionError(
      `Expected to be on branch "${expectedBranch}" but the working tree is on "${current}". Refusing to commit.`
    );
  }
}

export async function stageAndCommit(repoRoot: string, branchName: string, message: string, files: string[]): Promise<string> {
  await assertOnBranch(repoRoot, branchName);
  const git = client(repoRoot);
  if (files.length > 0) {
    await git.add(files);
  } else {
    // A coding-team worktree has node_modules symlinked in from the main
    // checkout (see agents/team/), which a `node_modules/` ignore rule
    // doesn't match — never let a catch-all add commit it.
    await git.raw(['add', '-A', '--', '.', ':(exclude)node_modules']);
  }
  const status = await git.status();
  if (status.staged.length === 0) {
    throw new GitPreconditionError('Nothing staged — no changes to commit.');
  }
  const result = await git.commit(message);
  return result.commit;
}

export async function diffAgainstBase(repoRoot: string, branchName: string, baseBranch = DEFAULT_BASE_BRANCH): Promise<string> {
  const git = client(repoRoot);
  return git.raw(['diff', `${baseBranch}...${branchName}`]);
}

export async function diffStatAgainstBase(repoRoot: string, branchName: string, baseBranch = DEFAULT_BASE_BRANCH): Promise<string> {
  const git = client(repoRoot);
  return git.raw(['diff', '--stat', `${baseBranch}...${branchName}`]);
}

export async function commitLogAgainstBase(
  repoRoot: string,
  branchName: string,
  baseBranch = DEFAULT_BASE_BRANCH
): Promise<{ hash: string; message: string; date: string }[]> {
  const git = client(repoRoot);
  const log = await git.log({ from: baseBranch, to: branchName });
  return log.all.map((c) => ({ hash: c.hash, message: c.message, date: c.date }));
}

export interface GitSetupResult {
  baseBranch: string;
  // What setup actually did, in plain words, for the Apps page to show.
  actions: string[];
  // Things setup couldn't do itself that will block the coding stage.
  warnings: string[];
}

const STARTER_GITIGNORE = 'node_modules/\n.env\n.env.*\n!.env.example\n.DS_Store\ndist/\nbuild/\ncoverage/\n';

async function hasCommitIdentity(git: SimpleGit): Promise<boolean> {
  const [name, email] = await Promise.all([git.getConfig('user.name'), git.getConfig('user.email')]);
  return Boolean(name.value?.trim() && email.value?.trim());
}

async function hasCommits(git: SimpleGit): Promise<boolean> {
  try {
    await git.revparse(['--verify', 'HEAD']);
    return true;
  } catch {
    return false;
  }
}

// Works on a repo with no commits yet too, where `git branch` lists nothing.
async function headBranch(git: SimpleGit): Promise<string> {
  try {
    return (await git.raw(['symbolic-ref', '--short', 'HEAD'])).trim() || DEFAULT_BASE_BRANCH;
  } catch {
    return DEFAULT_BASE_BRANCH;
  }
}

// Picks the branch the coding stage should branch off: master or main if
// either exists (in that order, matching the old hardcoded default), else
// whatever is checked out.
async function detectBaseBranch(git: SimpleGit): Promise<string> {
  const branches = await git.branchLocal();
  if (branches.all.includes('master')) return 'master';
  if (branches.all.includes('main')) return 'main';
  return headBranch(git);
}

/**
 * Makes repoRoot usable by the coding stage, which needs a git repo with a
 * clean base branch to branch off. A folder that isn't its own repo yet (a
 * brand-new app) gets `git init` on master, a starter .gitignore and an
 * initial commit of whatever is already there. An existing repo is left
 * alone except for committing the starter docs/ that ensureDocsDir() just
 * created (docsCreated), and only when it's on the base branch — otherwise
 * that new file would leave the base branch dirty and block the first
 * git_create_branch. Called from createApp/updateApp, never from the
 * read-only /api/apps/validate check.
 */
export async function setupGitRepo(repoRoot: string, opts: { docsCreated: boolean }): Promise<GitSetupResult> {
  const git = client(repoRoot);
  const actions: string[] = [];
  const warnings: string[] = [];

  let toplevel: string | null = null;
  try {
    toplevel = (await git.revparse(['--show-toplevel'])).trim();
  } catch {
    // not inside any repo
  }

  // A folder nested inside some other repo (e.g. a dotfiles repo at ~) still
  // gets its own — the agents' branches and commits must stay in this app.
  const isOwnRepo = toplevel !== null && path.resolve(toplevel) === path.resolve(repoRoot);
  if (!isOwnRepo) {
    await git.init(['--initial-branch', DEFAULT_BASE_BRANCH]);
    actions.push(`Initialized a git repository on ${DEFAULT_BASE_BRANCH}.`);
  }

  if (!existsSync(path.join(repoRoot, '.gitignore'))) {
    // Only for a repo with no history — an established repo without a
    // .gitignore is presumably that way on purpose.
    if (!isOwnRepo || !(await hasCommits(git))) {
      writeFileSync(path.join(repoRoot, '.gitignore'), STARTER_GITIGNORE);
      actions.push('Added a starter .gitignore.');
    }
  }

  if (!(await hasCommits(git))) {
    if (!(await hasCommitIdentity(git))) {
      warnings.push(
        'Git has no user.name/user.email configured, so no initial commit was made. Run `git config --global user.name "…"` ' +
          'and `git config --global user.email "…"`, then commit everything in this folder before starting a coding stage.'
      );
      return { baseBranch: await headBranch(git), actions, warnings };
    }
    await git.add('.');
    await git.commit('chore: initial commit', undefined, { '--allow-empty': null });
    actions.push('Made an initial commit of the folder\'s current contents.');
    return { baseBranch: await headBranch(git), actions, warnings };
  }

  const baseBranch = await detectBaseBranch(git);
  if (opts.docsCreated) {
    const status = await git.status();
    if (status.current === baseBranch && (await hasCommitIdentity(git))) {
      await git.add(['docs/README.md']);
      await git.commit('docs: add docs/ for Dev Sessions agents', ['docs/README.md']);
      actions.push(`Committed the new docs/README.md on ${baseBranch}.`);
    } else {
      warnings.push(`Commit the new docs/README.md on ${baseBranch} before starting a coding stage.`);
    }
  }
  const status = await git.status();
  if (status.current === baseBranch && !status.isClean()) {
    warnings.push(`${baseBranch} has uncommitted changes — commit or stash them before starting a coding stage.`);
  }
  return { baseBranch, actions, warnings };
}

// ---- Coding team: worktrees and merges -----------------------------------

// Serializes operations that touch one repo's shared state (the main
// checkout's working tree during a merge, worktree registration, branch
// refs) — team members finish at arbitrary times and must not merge at once.
const repoLocks = new Map<string, Promise<unknown>>();

export function withRepoLock<T>(repoRoot: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(repoRoot);
  const prev = repoLocks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  repoLocks.set(key, run.catch(() => undefined));
  return run;
}

/** Checks out `branch` in its own working tree at worktreePath, creating it from `fromRef` if it doesn't exist yet. */
export async function addWorktree(repoRoot: string, worktreePath: string, branch: string, fromRef: string): Promise<void> {
  const git = client(repoRoot);
  if (existsSync(path.join(worktreePath, '.git'))) return; // resuming — already set up
  await git.raw(['worktree', 'prune']);
  const { all } = await git.branchLocal();
  if (all.includes(branch)) {
    await git.raw(['worktree', 'add', worktreePath, branch]);
  } else {
    await git.raw(['worktree', 'add', '-b', branch, worktreePath, fromRef]);
  }
}

export async function removeWorktree(repoRoot: string, worktreePath: string): Promise<void> {
  const git = client(repoRoot);
  try {
    await git.raw(['worktree', 'remove', '--force', worktreePath]);
  } catch {
    // already gone
  }
  await git.raw(['worktree', 'prune']).catch(() => undefined);
}

export async function deleteBranch(repoRoot: string, branch: string): Promise<void> {
  await client(repoRoot)
    .raw(['branch', '-D', branch])
    .catch(() => undefined);
}

export async function hasUncommittedChanges(repoRoot: string): Promise<boolean> {
  const out = await client(repoRoot).raw(['status', '--porcelain', '--', '.', ':(exclude)node_modules']);
  return out.trim().length > 0;
}

export async function commitAll(repoRoot: string, message: string): Promise<string | null> {
  const git = client(repoRoot);
  await git.raw(['add', '-A', '--', '.', ':(exclude)node_modules']);
  const status = await git.status();
  if (status.staged.length === 0) return null;
  return (await git.commit(message)).commit || null;
}

export async function commitCount(repoRoot: string, from: string, to: string): Promise<number> {
  const out = await client(repoRoot).raw(['rev-list', '--count', `${from}..${to}`]);
  return Number(out.trim()) || 0;
}

/**
 * Merges `branch` into whatever the main checkout at repoRoot has checked
 * out (the session branch), as its own merge commit so the history shows
 * which team member built what. A conflicting merge is aborted rather than
 * left half-done — the caller reports it for a human.
 */
export async function mergeBranch(
  repoRoot: string,
  branch: string,
  message: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const git = client(repoRoot);
  try {
    await git.raw(['merge', '--no-ff', '-m', message, branch]);
    return { ok: true };
  } catch (err) {
    await git.raw(['merge', '--abort']).catch(() => undefined);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
