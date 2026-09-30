import { tool } from '@anthropic-ai/claude-agent-sdk';
import { fetchUrlSchema, fetchUrlDescription, createFetchUrlExecutor } from '../tool-defs/fetch-url-tool.js';
import { wrapForClaudeSdk } from './wrap.js';

export function createFetchUrlToolClaude(deps: { enabled: boolean }) {
  return tool('fetch_url', fetchUrlDescription, fetchUrlSchema.shape, wrapForClaudeSdk(createFetchUrlExecutor(deps)), {
    annotations: { readOnlyHint: true, openWorldHint: true },
  });
}
