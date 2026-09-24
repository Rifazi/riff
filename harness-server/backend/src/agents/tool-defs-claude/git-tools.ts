import { tool } from '@anthropic-ai/claude-agent-sdk';
import {
  createGitExecutors,
  gitCreateBranchSchema,
  gitCreateBranchDescription,
  gitCommitSchema,
  gitCommitDescription,
} from '../tool-defs/git-tools.js';
import { wrapForClaudeSdk } from './wrap.js';

export function createGitToolsClaude(deps: { repoRoot: string; onBranchCreated: (branchName: string) => Promise<void> }) {
  const { gitCreateBranchExecute, gitCommitExecute } = createGitExecutors(deps);
  return {
    gitCreateBranchTool: tool(
      'git_create_branch',
      gitCreateBranchDescription,
      gitCreateBranchSchema.shape,
      wrapForClaudeSdk(gitCreateBranchExecute)
    ),
    gitCommitTool: tool('git_commit', gitCommitDescription, gitCommitSchema.shape, wrapForClaudeSdk(gitCommitExecute)),
  };
}
