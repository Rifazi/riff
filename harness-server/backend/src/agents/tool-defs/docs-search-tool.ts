import { tool } from 'ai';
import { z } from 'zod';
import { readDocSection, searchDocs } from '../../repo/docs-index.js';

export const searchDocsSchema = z.object({
  query: z.string().describe('Keywords to search for, e.g. "square d cash sale format"'),
});
export const searchDocsDescription =
  'Full-text search over this repo\'s docs/ markdown files (architecture, ingestion, transmission, ops, API). ' +
  'Returns the top matching sections (truncated previews) with their file path and heading — use read_doc ' +
  'for a section\'s full text. Use this before proposing anything — this repo documents its own conventions ' +
  'in detail.';

export const readDocSchema = z.object({
  path: z.string().describe('Repo-relative path under docs/, e.g. docs/development.md'),
});
export const readDocDescription =
  'Read the full contents of one docs/*.md file by its repo-relative path (e.g. "docs/ingestion/invoices.md"). ' +
  'Only paths under docs/ are allowed.';

export function createDocsSearchExecutors(deps: { appId: string }) {
  const searchDocsExecute = async ({ query }: z.infer<typeof searchDocsSchema>): Promise<string> => {
    const results = searchDocs(deps.appId, query, 4);
    if (results.length === 0) return `No docs sections matched "${query}".`;
    return results.map((r) => `### ${r.file} — ${r.heading}\n${r.content.slice(0, 700)}`).join('\n\n---\n\n');
  };

  const readDocExecute = async ({ path: requestedPath }: z.infer<typeof readDocSchema>): Promise<string> => {
    if (!requestedPath.startsWith('docs/')) {
      throw new Error(`Refused: ${requestedPath} is not under docs/.`);
    }
    const content = readDocSection(deps.appId, requestedPath);
    if (content === null) {
      throw new Error(`No indexed content found for ${requestedPath}.`);
    }
    return content;
  };

  return { searchDocsExecute, readDocExecute };
}

export function createDocsSearchTools(deps: { appId: string }) {
  const { searchDocsExecute, readDocExecute } = createDocsSearchExecutors(deps);
  return {
    searchDocsTool: tool({ description: searchDocsDescription, inputSchema: searchDocsSchema, execute: searchDocsExecute }),
    readDocTool: tool({ description: readDocDescription, inputSchema: readDocSchema, execute: readDocExecute }),
  };
}
