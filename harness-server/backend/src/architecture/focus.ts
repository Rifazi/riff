import type { AppConfig } from '../apps/apps.js';
import type { SearchFocus } from '../agents/tool-defs/code-search-tool.js';
import { listDomains } from './wayfinding-audit.js';

// Where an agent's code searches start in an app that follows Wayfinding:
// the domains its work is about, so a search without a glob doesn't sweep
// the whole repo first (see search_code's `focus`).

type DomainRef = { id: string; dir: string };

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Folders of the domains `text` names, by folder path or by id as a whole word. */
export function domainsNamedIn(domains: DomainRef[], text: string): string[] {
  return domains
    .filter((d) => text.includes(d.dir) || new RegExp(`(?<![\\w/-])${escape(d.id)}(?![\\w-])`, 'i').test(text))
    .map((d) => d.dir);
}

/** Folders of the domains `files` (repo-relative) fall in, innermost domain per file. */
export function domainsOfFiles(domains: DomainRef[], files: string[]): string[] {
  const byDepth = [...domains].sort((a, b) => b.dir.length - a.dir.length);
  const dirs = new Set<string>();
  for (const file of files) {
    const owner = byDepth.find((d) => file.startsWith(`${d.dir}/`));
    if (owner) dirs.add(owner.dir);
  }
  return [...dirs].sort();
}

/**
 * A search focus on the domains `text()` names (a plan step, the
 * requirements), worked out on each search so it follows the agent from
 * one step to the next. No architecture, or no domain named → no focus.
 */
export function namedDomainsFocus(app: AppConfig, repoRoot: string, label: string, text: () => Promise<string | null>): SearchFocus | undefined {
  const config = app.architecture;
  if (!config) return undefined;
  return async () => {
    const source = await text();
    if (!source) return null;
    const paths = domainsNamedIn(listDomains(repoRoot, config), source);
    return paths.length ? { label, paths } : null;
  };
}

/** A search focus on the domains a set of changed files falls in (QA: the branch's). */
export function changedDomainsFocus(app: AppConfig, repoRoot: string, label: string, files: () => Promise<string[]>): SearchFocus | undefined {
  const config = app.architecture;
  if (!config) return undefined;
  return async () => {
    const paths = domainsOfFiles(listDomains(repoRoot, config), await files());
    return paths.length ? { label, paths } : null;
  };
}
