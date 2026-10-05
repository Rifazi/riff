import { tool } from '@anthropic-ai/claude-agent-sdk';
import { delegateSchema, delegateDescription, createDelegateExecute, type DelegateDeps } from '../tool-defs/delegate-tool.js';
import { wrapForClaudeSdk } from './wrap.js';

export function createDelegateToolClaude(deps: DelegateDeps) {
  return tool('delegate', delegateDescription, delegateSchema.shape, wrapForClaudeSdk(createDelegateExecute(deps)), {
    annotations: { readOnlyHint: true },
  });
}
