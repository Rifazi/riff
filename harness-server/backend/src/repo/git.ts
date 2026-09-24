import { simpleGit, type SimpleGit } from 'simple-git';

const BASE_BRANCH = 'master';

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

export async function assertCleanMasterForNewBranch(repoRoot: string): Promise<void> {
  const git = client(repoRoot);
  const status = await git.status();
  if (status.current !== BASE_BRANCH) {
    throw new GitPreconditionError(
      `Working tree is on "${status.current}", not "${BASE_BRANCH}". Switch to a clean ${BASE_BRANCH} before starting the coding stage.`
    );
  }
  if (!status.isClean()) {
    throw new GitPreconditionError(
      `${BASE_BRANCH} has uncommitted changes. Commit or stash them before starting the coding stage.`
    );
  }
}

export async function createBranch(repoRoot: string, branchName: string): Promise<void> {
  await assertCleanMasterForNewBranch(repoRoot);
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
    await git.add('.');
  }
  const status = await git.status();
  if (status.staged.length === 0) {
    throw new GitPreconditionError('Nothing staged — no changes to commit.');
  }
  const result = await git.commit(message);
  return result.commit;
}

export async function diffAgainstBase(repoRoot: string, branchName: string): Promise<string> {
  const git = client(repoRoot);
  return git.raw(['diff', `${BASE_BRANCH}...${branchName}`]);
}

export async function diffStatAgainstBase(repoRoot: string, branchName: string): Promise<string> {
  const git = client(repoRoot);
  return git.raw(['diff', '--stat', `${BASE_BRANCH}...${branchName}`]);
}

export async function commitLogAgainstBase(
  repoRoot: string,
  branchName: string
): Promise<{ hash: string; message: string; date: string }[]> {
  const git = client(repoRoot);
  const log = await git.log({ from: BASE_BRANCH, to: branchName });
  return log.all.map((c) => ({ hash: c.hash, message: c.message, date: c.date }));
}

export const BASE_BRANCH_NAME = BASE_BRANCH;
