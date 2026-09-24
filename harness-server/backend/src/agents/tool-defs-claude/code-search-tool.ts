import { tool } from '@anthropic-ai/claude-agent-sdk';
import { searchCodeSchema, searchCodeDescription, createSearchCodeExecute } from '../tool-defs/code-search-tool.js';
import { wrapForClaudeSdk } from './wrap.js';

export function createSearchCodeToolClaude(deps: { repoRoot: string }) {
  return tool(
    'search_code',
    searchCodeDescription,
    searchCodeSchema.shape,
    wrapForClaudeSdk(createSearchCodeExecute(deps)),
    { annotations: { readOnlyHint: true } }
  );
}
