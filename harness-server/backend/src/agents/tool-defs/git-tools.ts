import { tool } from 'ai';
import { z } from 'zod';
import { createBranch, stageAndCommit } from '../../repo/git.js';
import { checkoutSharedBranch } from '../../sessions/shared-branch.js';
import { formatFiles } from '../helpers/format/format.js';
import type { HelperContext } from '../helpers/helper.js';
import { assertWritable } from './file-tools.js';

const COMMIT_TYPES = ['build', 'chore', 'ci', 'docs', 'feat', 'fix', 'perf', 'refactor', 'revert', 'style', 'test'];
const COMMIT_PREFIX_RE = new RegExp(`^(${COMMIT_TYPES.join('|')})(\\([\\w./-]+\\))?: `);
const MAX_SUBJECT_CHARS = 72;

// Why `message` isn't an acceptable conventional commit, or null if it is.
// Says exactly what's wrong — a bare "not a conventional commit" had the
// agent guessing at valid-looking messages until one happened to pass.
export function commitMessageProblem(message: string): string | null {
  const firstLine = message.split('\n')[0];
  const prefix = COMMIT_PREFIX_RE.exec(firstLine);
  if (!prefix) {
    return `it must start with "type: " or "type(scope): ", where type is one of ${COMMIT_TYPES.join(', ')}`;
  }
  const subject = firstLine.slice(prefix[0].length);
  if (!subject.trim()) return 'the subject after the prefix is empty';
  if (subject.length > MAX_SUBJECT_CHARS) {
    return `the subject after "${prefix[0].trim()}" is ${subject.length} chars, max ${MAX_SUBJECT_CHARS} — shorten it, and put any detail in a body after a blank line`;
  }
  return null;
}

export const gitCreateBranchSchema = z.object({
  branchName: z.string().describe(
    'e.g. "API-1234_acme_inventory_report" — the ticket id in its own case (not lowercased) followed by a ' +
      'lowercase underscore-separated description, joined by an underscore. Use the "Suggested branch name" ' +
      'given below unless the human asks for something else.'
  ),
});
export const gitCreateBranchDescription =
  'Create and check out this session\'s feature branch off the app\'s clean base branch (master or main). Call this ' +
  'once, at the start of the coding stage, before any file writes. Fails if the base branch is not clean or the ' +
  'branch already exists.';

export const gitCommitSchema = z.object({
  branchName: z.string().describe('Must match the branch created by git_create_branch'),
  message: z.string(),
  files: z.array(z.string()).describe('Repo-relative paths to stage, e.g. ["src/global/schemas/acme.schema.json"]'),
});
export const gitCommitDescription =
  'Format (prettier) then stage and commit files on the session\'s branch; a prettier error commits nothing. ' +
  'The message must be a conventional commit ' +
  `(e.g. "feat: add acme inventory schema"), subject at most ${MAX_SUBJECT_CHARS} chars; details go in a body after a ` +
  'blank line. Non-conforming messages are rejected before anything is committed.';

/**
 * Branch creation and commits are the only git-write capabilities the coding
 * agent has — no push, merge, rebase, or checkout-off-branch tool exists at
 * all, so those actions are structurally unavailable, not just discouraged.
 */
export interface GitToolDeps {
  repoRoot: string;
  baseBranch?: string;
  // `base` is the commit the work starts from when it continues an existing
  // branch (SessionRecord.branchBase).
  onBranchCreated: (branchName: string, base?: string) => Promise<void>;
  // A split's shared branch this part continues on (sessions/shared-branch.ts):
  // git_create_branch checks it out instead of creating a branch.
  sharedBranch?: string | null;
  // A coding-team member's owned paths: commits can't include anything else.
  writablePaths?: string[];
  // Where formatter runs are reported (helpers/format).
  helperContext?: HelperContext;
  // Runs before branch creation and every commit, and throws to refuse it
  // (the lead's pending split decision).
  guard?: () => Promise<void>;
}

// The files git_commit formats: the ones an agent could have written. A
// lockfile, a generated theme file or one outside the owned paths is left as
// it is (stageAndCommit applies its own rules to what may be committed).
function formattable(repoRoot: string, files: string[], writablePaths?: string[]): string[] {
  return files.flatMap((f) => {
    try {
      return [assertWritable(f, repoRoot, writablePaths)];
    } catch {
      return [];
    }
  });
}

export function createGitExecutors(deps: GitToolDeps) {
  const gitCreateBranchExecute = async ({ branchName }: z.infer<typeof gitCreateBranchSchema>): Promise<string> => {
    await deps.guard?.();
    if (deps.sharedBranch) {
      const base = await checkoutSharedBranch(deps.repoRoot, deps.sharedBranch);
      await deps.onBranchCreated(deps.sharedBranch, base);
      return (
        `Checked out the feature's existing branch ${deps.sharedBranch}, where its earlier parts were built` +
        `${branchName !== deps.sharedBranch ? ` (instead of creating ${branchName})` : ''}. Commit this part's work on it.`
      );
    }
    await createBranch(deps.repoRoot, branchName, deps.baseBranch);
    await deps.onBranchCreated(branchName);
    return `Created and checked out branch ${branchName}.`;
  };

  const gitCommitExecute = async ({ branchName, message, files }: z.infer<typeof gitCommitSchema>): Promise<string> => {
    await deps.guard?.();
    const problem = commitMessageProblem(message);
    if (problem) {
      throw new Error(`Not committed: ${problem}. Message was: "${message.split('\n')[0]}"`);
    }
    const formatted = await formatFiles(deps.repoRoot, formattable(deps.repoRoot, files, deps.writablePaths), deps.helperContext);
    if (!formatted.ok) return `Nothing committed: prettier failed (usually a syntax error).\n\n${formatted.output}`;
    const hash = await stageAndCommit(deps.repoRoot, branchName, message, files, deps.writablePaths);
    return `Committed ${hash.slice(0, 8)}: ${message}`;
  };

  return { gitCreateBranchExecute, gitCommitExecute };
}

export function createGitTools(deps: GitToolDeps) {
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
