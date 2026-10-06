import { createHash } from 'node:crypto';
import { tool } from 'ai';
import { z } from 'zod';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { config } from '../../config.js';
import { docsSearchScope, readDocSection, selectSections, splitIntoSections, syncDocsSearch } from '../../repo/docs-index.js';
import { readReferenceDoc, syncReferenceDocsSearch } from '../../sessions/reference-docs.js';
import { getSession } from '../../sessions/session-store.js';
import { searchIndex } from '../../search/search-engine.js';
import { SESSION_PLAN_DOC, SESSION_REQUIREMENTS_DOC } from '../plan-excerpt.js';
import { readRepoInstructions, REPO_INSTRUCTIONS_FILE } from '../repo-instructions.js';
import { getApp } from '../../apps/apps-store.js';

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
  path: z
    .string()
    .describe(
      `Repo-relative path under docs/ (e.g. docs/development.md), the repo's ${REPO_INSTRUCTIONS_FILE}, a reference document path (reference/…), or this session's approved ${SESSION_PLAN_DOC} / ${SESSION_REQUIREMENTS_DOC}`
    ),
  heading: z
    .string()
    .optional()
    .describe('A heading as search_docs shows it, e.g. "Ingestion > Invoices" — returns that section and its subsections only'),
});
export const readDocDescription =
  'Read one docs/*.md file by its repo-relative path (e.g. "docs/ingestion/invoices.md") — the whole file, or ' +
  'with `heading` just the section a search_docs result pointed at, including its subsections. Also reads the ' +
  `reference documents the human attached (reference/… paths), the repo's ${REPO_INSTRUCTIONS_FILE}, and this session's approved plan and requirements ` +
  `(${SESSION_PLAN_DOC}, ${SESSION_REQUIREMENTS_DOC}). Only those paths are allowed.`;

// sessionId adds that session's own reference documents to the app's.
export function createDocsSearchExecutors(deps: { appId: string; sessionId?: string; repoRoot?: string }) {
  const notedRepeats = new Map<string, string>();
  const lastReads = new Map<string, string>();

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
    let content: string;
    if (requestedPath.startsWith('reference/')) {
      const raw = await readReferenceDoc(deps.appId, deps.sessionId, requestedPath, heading);
      if (raw === null) throw new Error(`No reference document at ${requestedPath}.`);
      content = raw;
    } else if (requestedPath === REPO_INSTRUCTIONS_FILE) {
      content = await readRepoInstructions(deps.repoRoot ?? (await getApp(deps.appId)).repoRoot, heading);
    } else if (requestedPath === SESSION_PLAN_DOC || requestedPath === SESSION_REQUIREMENTS_DOC) {
      content = await readSessionDoc(deps.sessionId, requestedPath, heading);
    } else {
      if (!requestedPath.startsWith('docs/')) {
        throw new Error(`Refused: ${requestedPath} is not under docs/ or reference/, nor ${REPO_INSTRUCTIONS_FILE}, ${SESSION_PLAN_DOC} / ${SESSION_REQUIREMENTS_DOC}.`);
      }
      const raw = readDocSection(deps.appId, requestedPath, heading);
      if (raw === null) throw new Error(`No indexed content found for ${requestedPath}.`);
      content = raw;
    }

    const key = `${requestedPath}\u0000${heading ?? ''}`;
    const hash = createHash('sha1').update(content).digest('hex');
    if (lastReads.get(key) === hash && notedRepeats.get(key) !== hash) {
      notedRepeats.set(key, hash);
      return `[${requestedPath}${heading ? ` > ${heading}` : ''} is unchanged since you last read it — use that copy. Call again to get the text.]`;
    }
    notedRepeats.delete(key);
    lastReads.set(key, hash);
    return content;
  };

  return { searchDocsExecute, readDocExecute };
}

// The approved plan/requirements live in this project's artifacts/, not the
// target repo. Coding conversations get only their own plan step inline
// (agents/plan-excerpt.ts) and read the rest here.
async function readSessionDoc(sessionId: string | undefined, requestedPath: string, heading?: string): Promise<string> {
  const session = sessionId ? await getSession(sessionId) : null;
  const relPath = requestedPath === SESSION_PLAN_DOC ? session?.planPath : session?.requirementsPath;
  if (!relPath) throw new Error(`This session has no approved ${requestedPath.replace(/^session\/|\.md$/g, '')} yet.`);
  const markdown = await fs.readFile(path.join(config.harnessRoot, relPath), 'utf8');
  if (!heading) return markdown;
  const matches = selectSections(splitIntoSections(requestedPath, markdown), requestedPath, heading) ?? [];
  return matches.map((s) => `## ${s.heading}\n\n${s.content}`).join('\n\n---\n\n');
}

export function createDocsSearchTools(deps: { appId: string; sessionId?: string; repoRoot?: string }) {
  const { searchDocsExecute, readDocExecute } = createDocsSearchExecutors(deps);
  return {
    searchDocsTool: tool({ description: searchDocsDescription, inputSchema: searchDocsSchema, execute: searchDocsExecute }),
    readDocTool: tool({ description: readDocDescription, inputSchema: readDocSchema, execute: readDocExecute }),
  };
}
