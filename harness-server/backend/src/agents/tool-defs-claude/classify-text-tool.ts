import { tool } from '@anthropic-ai/claude-agent-sdk';
import { classifyTextSchema, classifyTextDescription, classifyTextExecute } from '../tool-defs/classify-text-tool.js';
import { wrapForClaudeSdk } from './wrap.js';

export const classifyTextToolClaude = tool(
  'classify_text',
  classifyTextDescription,
  classifyTextSchema.shape,
  wrapForClaudeSdk(classifyTextExecute),
);
