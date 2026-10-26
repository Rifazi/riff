import matter from 'gray-matter';
import type { AppConfig } from '../apps/apps.js';
import { docsSearchScope, listIndexedFiles, syncDocsSearch } from '../repo/docs-index.js';
import { searchIndex } from '../search/search-engine.js';
import { numberedCriteria } from './requirements-digest.js';

// Which docs the context agent ingests for a session: the ones the
// requirements cite or ask to update, then the few the search ranks highest
// for the work. Everything else stays unread.
export const MAX_NEEDED_DOCS = 10;
// Search scores are rank-based, so they can't say a hit is relevant: take the top few and no more.
export const MAX_SEARCHED_DOCS = 3;
const QUERY_CHARS = 1200;

/** What the work is about, as search text: a requirements document's title and criteria. */
export function queryFromRequirements(raw: string): string {
  const body = matter(raw).content;
  const title = body.match(/^#\s+(.*)$/m)?.[1] ?? '';
  const start = body.split('\n').findIndex((l) => /^##\s+acceptance/i.test(l.trim()));
  const rest = start < 0 ? [] : body.split('\n').slice(start + 1);
  const end = rest.findIndex((l) => /^##\s/.test(l));
  const criteria = numberedCriteria((end < 0 ? rest : rest.slice(0, end)).join('\n')).map((c) => c.replace(/^AC\d+\.\s*/, ''));
  return [title, ...criteria].join('. ').slice(0, QUERY_CHARS);
}

/** Cited docs first (a cited path matches an indexed file by its full path or a trailing part), then the top search hits, deduplicated, capped. */
export function pickNeededDocs(
  cited: readonly string[],
  hits: readonly string[],
  indexed: readonly string[],
  max = MAX_NEEDED_DOCS
): string[] {
  const known = new Set(indexed);
  const picked: string[] = [];
  const add = (file: string | undefined) => {
    if (file && known.has(file) && !picked.includes(file)) picked.push(file);
  };
  for (const c of cited) add(indexed.find((f) => f === c || f.endsWith(`/${c}`)));
  const cites = picked.length;
  for (const h of hits) {
    if (picked.length - cites >= MAX_SEARCHED_DOCS) break;
    add(h);
  }
  return picked.slice(0, max);
}

/** The docs worth ingesting for `query`. With no search engine available, only the cited ones. */
export async function neededDocs(app: AppConfig, query: string, cited: readonly string[]): Promise<string[]> {
  const indexed = listIndexedFiles(app.id);
  let hits: string[] = [];
  if (query.trim() && indexed.length > 0) {
    try {
      await syncDocsSearch(app.id);
      hits = (await searchIndex({ text: query, scopes: [docsSearchScope(app.id)], kinds: ['doc'], limit: 30 })).map((h) => h.key);
    } catch {
      // search unavailable: cited docs only
    }
  }
  return pickNeededDocs(cited, hits, indexed);
}
