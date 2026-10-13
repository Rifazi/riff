import { tool } from '@anthropic-ai/claude-agent-sdk';
import { wrapForClaudeSdk } from '../../tool-defs-claude/wrap.js';
import type { HelperContext } from '../helper.js';
import { classifyTextSchema, classifyTextDescription, createClassifyTextExecute } from './tool.js';

export function createClassifyTextToolClaude(context?: HelperContext) {
  return tool(
    'classify_text',
    classifyTextDescription,
    classifyTextSchema.shape,
    wrapForClaudeSdk(createClassifyTextExecute(context)),
  );
}

/** classify_text for the Claude engine's tool list, when it's turned on. */
export function classifyTextToolsClaude(enabled: boolean, context?: HelperContext) {
  return enabled ? [createClassifyTextToolClaude(context)] : [];
}
