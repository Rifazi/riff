import { tool } from '@anthropic-ai/claude-agent-sdk';
import type { CheckCommands } from '../../apps/apps.js';
import {
  runCheckedCommandSchema,
  runCheckedCommandDescription,
  getDiffSchema,
  getDiffDescription,
  createQaExecutors,
} from '../tool-defs/qa-tools.js';
import { wrapForClaudeSdk } from './wrap.js';

export function createQaToolsClaude(deps: { repoRoot: string; checkCommands?: CheckCommands }) {
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
