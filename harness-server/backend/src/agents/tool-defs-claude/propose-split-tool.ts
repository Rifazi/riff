import { tool } from '@anthropic-ai/claude-agent-sdk';
import { proposeSplitSchema, proposeSplitDescription, createProposeSplitExecute } from '../tool-defs/propose-split-tool.js';
import { wrapForClaudeSdk } from './wrap.js';

export function createProposeSplitToolClaude(sessionInfo: { sessionId: string; sessionKey: string }) {
  return tool('propose_split', proposeSplitDescription, proposeSplitSchema.shape, wrapForClaudeSdk(createProposeSplitExecute(sessionInfo)));
}
