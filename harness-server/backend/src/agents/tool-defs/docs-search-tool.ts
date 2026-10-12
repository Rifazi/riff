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
import { DOMAIN_DOC, MAP_PATH } from '../../architecture/architecture.js';
import { assertPathAllowed } from '../../repo/guardrails.js';
import { ReadMemo } from './read-memo.js';

export const searchDocsSchema = z.object({
  query: z.string().describe('Keywords or a question, e.g. "square d cash sale format" or "how are invoices retried?"'),
});
export const searchDocsDescription =
  'Search this repo\'s docs/ markdown files (architecture, ingestion, transmission, ops, API) by keyword and by ' +
  'meaning, so a question finds the section that answers it even in other words. ' +
  'Also searches the reference documents the human attached (paths under reference/), and in an app that follows ' +
  `Wayfinding Architecture its ${MAP_PATH} and every ${DOMAIN_DOC}. ` +
  'Returns the top matching sections (truncated previews) with their file path and heading — use read_doc ' +
  'for a section\'s full text. Use this before proposing anything — this repo documents its own conventions ' +
  'in detail.';

export const readDocSchema = z.object({
  path: z
    .string()
    .describe(
      `Repo-relative path under docs/ (e.g. docs/development.md), the repo's ${REPO_INSTRUCTIONS_FILE}, ${MAP_PATH} or a ${DOMAIN_DOC} (e.g. src/pricing/${DOMAIN_DOC}), a reference document path (reference/…), or this session's approved ${SESSION_PLAN_DOC} / ${SESSION_REQUIREMENTS_DOC}`
    ),
  heading: z
    .string()
    .optional()
    .describe('A heading as search_docs shows it, e.g. "Ingestion > Invoices" — returns that section and its subsections only'),
});
export const readDocDescription =
  'Read one docs/*.md file by its repo-relative path (e.g. "docs/ingestion/invoices.md") — the whole file, or ' +
  'with `heading` just the section a search_docs result pointed at, including its subsections. Also reads the ' +
  `reference documents the human attached (reference/… paths), the repo's ${REPO_INSTRUCTIONS_FILE}, ${MAP_PATH} and ${DOMAIN_DOC} files, and this session's approved plan and requirements ` +
  `(${SESSION_PLAN_DOC}, ${SESSION_REQUIREMENTS_DOC}). Only those paths are allowed.`;

// sessionId adds that session's own reference documents to the app's.
export interface DocsSearchDeps {
  appId: string;
  sessionId?: string;
  repoRoot?: string;
  /** Shared with the agent's other read tools and cleared on compaction; a fresh one when unset. */
  readMemo?: ReadMemo;
}

export function createDocsSearchExecutors(deps: DocsSearchDeps) {
  const readMemo = deps.readMemo ?? new ReadMemo();

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
    } else if (requestedPath === MAP_PATH || path.posix.basename(requestedPath) === DOMAIN_DOC) {
      content = await readArchitectureDoc(deps.repoRoot ?? (await getApp(deps.appId)).repoRoot, requestedPath, heading);
    } else {
      if (!requestedPath.startsWith('docs/')) {
        throw new Error(
          `Refused: ${requestedPath} is not under docs/ or reference/, nor ${REPO_INSTRUCTIONS_FILE}, ${MAP_PATH}, a ${DOMAIN_DOC}, ${SESSION_PLAN_DOC} / ${SESSION_REQUIREMENTS_DOC}.`
        );
      }
      const raw = readDocSection(deps.appId, requestedPath, heading);
      if (raw === null) throw new Error(`No indexed content found for ${requestedPath}.`);
      content = raw;
    }

    if (readMemo.isRepeat(`doc\u0000${requestedPath}\u0000${heading ?? ''}`, content)) {
      return `[${requestedPath}${heading ? ` > ${heading}` : ''} is unchanged since you last read it — use that copy. Call again to get the text.]`;
    }
    return content;
  };

  return { searchDocsExecute, readDocExecute };
}

// Wayfinding's map and domain docs (architecture/), read from the checkout
// itself rather than the docs/ index: they live beside the code, and the
// requirements and plan agents have no read_file.
async function readArchitectureDoc(repoRoot: string, requestedPath: string, heading?: string): Promise<string> {
  const absolute = assertPathAllowed(requestedPath, ['.'], repoRoot);
  let markdown: string;
  try {
    markdown = await fs.readFile(absolute, 'utf8');
  } catch {
    throw new Error(`${requestedPath} doesn't exist.`);
  }
  if (!heading) return markdown;
  const sections = splitIntoSections(requestedPath, markdown);
  // Headings are paths ("pricing > Hidden behavior"); also accept one without its parents.
  const wanted = heading.trim().toLowerCase();
  let prefix = heading;
  for (const s of sections) {
    const parts = s.heading.split(' > ');
    const i = parts.findIndex((p) => p.toLowerCase() === wanted);
    if (i >= 0) {
      prefix = parts.slice(0, i + 1).join(' > ');
      break;
    }
  }
  const matches = selectSections(sections, requestedPath, prefix) ?? [];
  if (!matches.length) throw new Error(`${requestedPath} has no section "${heading}".`);
  return matches.map((s) => `## ${s.heading}\n\n${s.content}`).join('\n\n---\n\n');
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

export function createDocsSearchTools(deps: DocsSearchDeps) {
  const { searchDocsExecute, readDocExecute } = createDocsSearchExecutors(deps);
  return {
    searchDocsTool: tool({ description: searchDocsDescription, inputSchema: searchDocsSchema, execute: searchDocsExecute }),
    readDocTool: tool({ description: readDocDescription, inputSchema: readDocSchema, execute: readDocExecute }),
  };
}
