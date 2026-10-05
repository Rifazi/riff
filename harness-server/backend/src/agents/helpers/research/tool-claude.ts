import { tool } from '@anthropic-ai/claude-agent-sdk';
import { wrapForClaudeSdk } from '../../tool-defs-claude/wrap.js';
import { delegateSchema, delegateDescription, createDelegateExecute, type DelegateDeps } from './tool.js';

export function createDelegateToolClaude(deps: DelegateDeps) {
  return tool('delegate', delegateDescription, delegateSchema.shape, wrapForClaudeSdk(createDelegateExecute(deps)), {
    annotations: { readOnlyHint: true },
  });
}
