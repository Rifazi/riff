import { tool } from '@anthropic-ai/claude-agent-sdk';
import { widenFixScopeSchema, widenFixScopeDescription, createWidenFixScopeExecute } from '../tool-defs/fix-scope-tool.js';
import { wrapForClaudeSdk } from './wrap.js';

export function createWidenFixScopeToolClaude(deps: { sessionId: string }) {
  return tool('widen_fix_scope', widenFixScopeDescription, widenFixScopeSchema.shape, wrapForClaudeSdk(createWidenFixScopeExecute(deps)));
}
