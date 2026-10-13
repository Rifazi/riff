import { tool } from '@anthropic-ai/claude-agent-sdk';
import {
  runCheckedCommandSchema,
  runCheckedCommandDescription,
  getDiffSchema,
  getDiffDescription,
  createQaExecutors,
  type QaExecutorDeps,
} from '../tool-defs/qa-tools.js';
import { wrapForClaudeSdk } from './wrap.js';

export function createQaToolsClaude(deps: QaExecutorDeps) {
  const { runCheckedCommandExecute, getDiffExecute } = createQaExecutors(deps);
  return {
    runCheckedCommandToolClaude: tool(
      'run_checked_command',
      runCheckedCommandDescription,
      runCheckedCommandSchema.shape,
      wrapForClaudeSdk(runCheckedCommandExecute)
    ),
    getDiffToolClaude: tool('get_diff', getDiffDescription, getDiffSchema.shape, wrapForClaudeSdk(getDiffExecute), {
      annotations: { readOnlyHint: true },
    }),
  };
}
