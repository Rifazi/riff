import { tool } from 'ai';
import { z } from 'zod';
import { docsSearchScope, readDocSection, syncDocsSearch } from '../../repo/docs-index.js';
import { readReferenceDoc, syncReferenceDocsSearch } from '../../sessions/reference-docs.js';
import { searchIndex } from '../../search/search-engine.js';

export const searchDocsSchema = z.object({
  query: z.string().describe('Keywords or a question, e.g. "square d cash sale format" or "how are invoices retried?"'),
});
export const searchDocsDescription =
  'Search this repo\'s docs/ markdown files (architecture, ingestion, transmission, ops, API) by keyword and by ' +
  'meaning, so a question finds the section that answers it even in other words. ' +
  'Also searches the reference documents the human attached (paths under reference/). ' +
  'Returns the top matching sections (truncated previews) with their file path and heading — use read_doc ' +
  'for a section\'s full text. Use this before proposing anything — this repo documents its own conventions ' +
  'in detail.';

export const readDocSchema = z.object({
  path: z.string().describe('Repo-relative path under docs/ (e.g. docs/development.md), or a reference document path (reference/…)'),
  heading: z
    .string()
    .optional()
    .describe('A heading as search_docs shows it, e.g. "Ingestion > Invoices" — returns that section and its subsections only'),
});
export const readDocDescription =
  'Read one docs/*.md file by its repo-relative path (e.g. "docs/ingestion/invoices.md") — the whole file, or ' +
  'with `heading` just the section a search_docs result pointed at, including its subsections. Also reads the ' +
  'reference documents the human attached (reference/… paths). Only paths under docs/ or reference/ are allowed.';

// sessionId adds that session's own reference documents to the app's.
export function createDocsSearchExecutors(deps: { appId: string; sessionId?: string }) {
  const searchDocsExecute = async ({ query }: z.infer<typeof searchDocsSchema>): Promise<string> => {
    const [referenceScopes] = await Promise.all([
      syncReferenceDocsSearch(deps.appId, deps.sessionId),
      syncDocsSearch(deps.appId),
    ]);
    const hits = await searchIndex({ text: query, scopes: [docsSearchScope(deps.appId), ...referenceScopes], limit: 12 });
    // Several chunks of one long section can match; show each section once.
    const seen = new Set<string>();
    const results = hits
      .filter((h) => {
        const id = `${h.key}\u0000${h.heading ?? ''}`;
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      })
      .slice(0, 4);
    if (results.length === 0) return `No docs sections matched "${query}".`;
    return results.map((r) => `### ${r.key} — ${r.heading ?? r.title}\n${r.text.slice(0, 700)}`).join('\n\n---\n\n');
  };

  const readDocExecute = async ({ path: requestedPath, heading }: z.infer<typeof readDocSchema>): Promise<string> => {
    if (requestedPath.startsWith('reference/')) {
      const content = await readReferenceDoc(deps.appId, deps.sessionId, requestedPath, heading);
      if (content === null) throw new Error(`No reference document at ${requestedPath}.`);
      return content;
    }
    if (!requestedPath.startsWith('docs/')) {
      throw new Error(`Refused: ${requestedPath} is not under docs/ or reference/.`);
    }
    const content = readDocSection(deps.appId, requestedPath, heading);
    if (content === null) {
      throw new Error(`No indexed content found for ${requestedPath}.`);
    }
    return content;
  };

  return { searchDocsExecute, readDocExecute };
}

export function createDocsSearchTools(deps: { appId: string; sessionId?: string }) {
  const { searchDocsExecute, readDocExecute } = createDocsSearchExecutors(deps);
  return {
    searchDocsTool: tool({ description: searchDocsDescription, inputSchema: searchDocsSchema, execute: searchDocsExecute }),
    readDocTool: tool({ description: readDocDescription, inputSchema: readDocSchema, execute: readDocExecute }),
  };
}
