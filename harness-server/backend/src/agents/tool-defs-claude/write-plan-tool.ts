import { tool } from '@anthropic-ai/claude-agent-sdk';
import { createWritePlanExecute, writePlanSchema, writePlanDescription } from '../tool-defs/write-plan-tool.js';
import { wrapForClaudeSdk } from './wrap.js';

export function createWritePlanToolClaude(sessionInfo: { sessionKey: string; sessionId: string; requirementsPath: string }) {
  return tool('write_plan_doc', writePlanDescription, writePlanSchema.shape, wrapForClaudeSdk(createWritePlanExecute(sessionInfo)));
}
