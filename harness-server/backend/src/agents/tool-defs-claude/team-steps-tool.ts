import { tool } from '@anthropic-ai/claude-agent-sdk';
import { updateMyStepsSchema, updateMyStepsDescription, createUpdateMyStepsExecute } from '../tool-defs/team-steps-tool.js';
import { wrapForClaudeSdk } from './wrap.js';

export function createUpdateMyStepsToolClaude(deps: { sessionId: string; stepIds: string[] }) {
  return tool('update_my_steps', updateMyStepsDescription, updateMyStepsSchema.shape, wrapForClaudeSdk(createUpdateMyStepsExecute(deps)));
}
