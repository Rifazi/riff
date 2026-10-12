import { tool } from '@anthropic-ai/claude-agent-sdk';
import { wrapForClaudeSdk } from '../../tool-defs-claude/wrap.js';
import { recallDescription, recallSchema } from './core.js';
import { createRecallExecute, type ReadMemoryDeps } from './tool.js';

export function createRecallToolClaude(deps: ReadMemoryDeps) {
  return tool('recall', recallDescription, recallSchema.shape, wrapForClaudeSdk(createRecallExecute(deps)));
}
