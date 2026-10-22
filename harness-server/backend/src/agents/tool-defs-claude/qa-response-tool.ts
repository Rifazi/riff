import { tool } from '@anthropic-ai/claude-agent-sdk';
import { respondToQaSchema, respondToQaDescription, createRespondToQaExecute } from '../tool-defs/qa-response-tool.js';
import { wrapForClaudeSdk } from './wrap.js';

export function createRespondToQaToolClaude(deps: { sessionId: string }) {
  return tool('respond_to_qa', respondToQaDescription, respondToQaSchema.shape, wrapForClaudeSdk(createRespondToQaExecute(deps)));
}
