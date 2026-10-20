import { tool } from '@anthropic-ai/claude-agent-sdk';
import { rememberDesignSchema, rememberDesignDescription, createRememberDesignExecute } from '../tool-defs/design-memory-tool.js';
import { wrapForClaudeSdk } from './wrap.js';

export function createRememberDesignToolClaude(deps: { appId: string; sessionId: string }) {
  return tool('remember_design', rememberDesignDescription, rememberDesignSchema.shape, wrapForClaudeSdk(createRememberDesignExecute(deps)));
}
