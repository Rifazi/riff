import { tool } from '@anthropic-ai/claude-agent-sdk';
import { createStartCodingExecute, startCodingDescription, startCodingSchema } from '../tool-defs/start-coding-tool.js';
import { wrapForClaudeSdk } from './wrap.js';

export function createStartCodingToolClaude(deps: { sessionId: string }) {
  return tool('start_coding', startCodingDescription, startCodingSchema.shape, wrapForClaudeSdk(createStartCodingExecute(deps)));
}
