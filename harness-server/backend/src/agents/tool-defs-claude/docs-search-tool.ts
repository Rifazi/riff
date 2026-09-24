import { tool } from '@anthropic-ai/claude-agent-sdk';
import {
  searchDocsSchema,
  searchDocsDescription,
  readDocSchema,
  readDocDescription,
  createDocsSearchExecutors,
} from '../tool-defs/docs-search-tool.js';
import { wrapForClaudeSdk } from './wrap.js';

export function createDocsSearchToolsClaude(deps: { appId: string }) {
  const { searchDocsExecute, readDocExecute } = createDocsSearchExecutors(deps);
  return {
    searchDocsToolClaude: tool(
      'search_docs',
      searchDocsDescription,
      searchDocsSchema.shape,
      wrapForClaudeSdk(searchDocsExecute),
      { annotations: { readOnlyHint: true } }
    ),
    readDocToolClaude: tool('read_doc', readDocDescription, readDocSchema.shape, wrapForClaudeSdk(readDocExecute), {
      annotations: { readOnlyHint: true },
    }),
  };
}
