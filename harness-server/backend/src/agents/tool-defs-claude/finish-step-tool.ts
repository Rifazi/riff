import { tool } from '@anthropic-ai/claude-agent-sdk';
import { finishStepSchema, finishStepDescription, createFinishStepExecute, type FinishStepDeps } from '../tool-defs/finish-step-tool.js';
import { wrapForClaudeSdk } from './wrap.js';

export function createFinishStepToolClaude(deps: FinishStepDeps) {
  return tool('finish_step', finishStepDescription, finishStepSchema.shape, wrapForClaudeSdk(createFinishStepExecute(deps)));
}
