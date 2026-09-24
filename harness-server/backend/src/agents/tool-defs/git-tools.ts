import { tool } from 'ai';
import { z } from 'zod';
import { createBranch, stageAndCommit } from '../../repo/git.js';

const CONVENTIONAL_COMMIT_RE =
  /^(build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(\([\w./-]+\))?: .{1,72}$/;

export const gitCreateBranchSchema = z.object({
  branchName: z.string().describe(
    'e.g. "API-1234_acme_inventory_report" — the ticket id in its own case (not lowercased) followed by a ' +
      'lowercase underscore-separated description, joined by an underscore. Use the "Suggested branch name" ' +
      'given below unless the human asks for something else.'
  ),
});
export const gitCreateBranchDescription =
  'Create and check out this session\'s feature branch off a clean master. Call this once, at the start of ' +
  'the coding stage, before any file writes. Fails if master is not clean or the branch already exists.';

export const gitCommitSchema = z.object({
  branchName: z.string().describe('Must match the branch created by git_create_branch'),
  message: z.string(),
  files: z.array(z.string()).describe('Repo-relative paths to stage, e.g. ["src/global/schemas/acme.schema.json"]'),
});
export const gitCommitDescription =
  'Stage and commit files on the session\'s branch. The message must be a conventional commit ' +
  '(e.g. "feat: add acme inventory schema") — non-conforming messages are rejected before anything is committed.';

/**
 * Branch creation and commits are the only git-write capabilities the coding
 * agent has — no push, merge, rebase, or checkout-off-branch tool exists at
 * all, so those actions are structurally unavailable, not just discouraged.
 */
export function createGitExecutors(deps: { repoRoot: string; onBranchCreated: (branchName: string) => Promise<void> }) {
  const gitCreateBranchExecute = async ({ branchName }: z.infer<typeof gitCreateBranchSchema>): Promise<string> => {
    await createBranch(deps.repoRoot, branchName);
    await deps.onBranchCreated(branchName);
    return `Created and checked out branch ${branchName}.`;
  };

  const gitCommitExecute = async ({ branchName, message, files }: z.infer<typeof gitCommitSchema>): Promise<string> => {
    if (!CONVENTIONAL_COMMIT_RE.test(message)) {
      throw new Error(
        `"${message}" is not a conventional commit (type(scope): subject, e.g. "feat: add acme schema"). Not committed.`
      );
    }
    const hash = await stageAndCommit(deps.repoRoot, branchName, message, files);
    return `Committed ${hash.slice(0, 8)}: ${message}`;
  };

  return { gitCreateBranchExecute, gitCommitExecute };
}

export function createGitTools(deps: { repoRoot: string; onBranchCreated: (branchName: string) => Promise<void> }) {
  const { gitCreateBranchExecute, gitCommitExecute } = createGitExecutors(deps);
  return {
    gitCreateBranchTool: tool({
      description: gitCreateBranchDescription,
      inputSchema: gitCreateBranchSchema,
      execute: gitCreateBranchExecute,
    }),
    gitCommitTool: tool({
      description: gitCommitDescription,
      inputSchema: gitCommitSchema,
      execute: gitCommitExecute,
    }),
  };
}
