import { tool } from '@anthropic-ai/claude-agent-sdk';
import { createWriteCodingPlanExecute, writeCodingPlanSchema, writeCodingPlanDescription } from '../tool-defs/coding-plan-tool.js';
import { wrapForClaudeSdk } from './wrap.js';

export function createWriteCodingPlanToolClaude(sessionId: string) {
  return tool(
    'write_coding_plan',
    writeCodingPlanDescription,
    writeCodingPlanSchema.shape,
    wrapForClaudeSdk(createWriteCodingPlanExecute(sessionId))
  );
}
