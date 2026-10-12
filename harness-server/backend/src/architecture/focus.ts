import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AppConfig } from '../apps/apps.js';
import type { SearchFocus, SearchListing } from '../agents/tool-defs/code-search-tool.js';
import { DOMAIN_DOC } from './architecture.js';
import { listDomains, sectionBody } from './wayfinding-audit.js';

const execFileAsync = promisify(execFile);

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

// ------------------------------------------------------------ file listings

const MAX_LISTED_DOMAINS = 40;
const MAX_OFF_MAP_FILES = 40;
const LOCKFILE = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/;

/** A domain's generated Files lines, or null when it has no Files section yet. */
function filesSection(doc: string): string[] | null {
  const lines = sectionBody(doc, 'Files')
    .split('\n')
    .filter((l) => l.trim() && !l.trim().startsWith('<!--'));
  return lines.length ? lines : null;
}

/**
 * What search_code answers, in a Wayfinding app, for a pattern that matches
 * every line (an agent listing a folder): the Files sections of the domains
 * the tracked files under `glob` fall in, plus the files on no domain. null
 * when none of those files is on a domain, so the caller lists them plainly.
 */
export async function listByDomain(
  repoRoot: string,
  domains: { id: string; dir: string }[],
  glob: string | undefined
): Promise<string | null> {
  const { stdout } = await execFileAsync('git', ['ls-files', '-z', '--', glob ?? '.'], { cwd: repoRoot, maxBuffer: 20_000_000 });
  const files = stdout.split('\0').filter((f) => f && !LOCKFILE.test(f));
  const byDepth = [...domains].sort((a, b) => b.dir.length - a.dir.length);
  const hit = new Set<string>();
  const offMap: string[] = [];
  for (const file of files) {
    const owner = byDepth.find((d) => file.startsWith(`${d.dir}/`));
    if (owner) hit.add(owner.dir);
    else offMap.push(file);
  }
  if (!hit.size) return null;

  const dirs = [...hit].sort();
  const out = [
    `Nothing listed line by line: a pattern that matches every line only lists files, and these are on the code map. ` +
      `Each domain's Files section below is generated from the code and kept current by audit_architecture, so it is ` +
      `the complete list of that domain's files and exports (child domains list their own). read_doc a ${DOMAIN_DOC} ` +
      `for its rules; search with a real pattern to find a line.`,
  ];
  for (const dir of dirs.slice(0, MAX_LISTED_DOMAINS)) {
    let doc = '';
    try {
      doc = readFileSync(path.join(repoRoot, dir, DOMAIN_DOC), 'utf8');
    } catch {
      // Listed as a domain a moment ago; treat as an empty doc.
    }
    const listed = filesSection(doc);
    const own = files.filter((f) => byDepth.find((d) => f.startsWith(`${d.dir}/`))?.dir === dir).map((f) => `- \`${f.slice(dir.length + 1)}\``);
    out.push(
      `\n${dir}/${DOMAIN_DOC}` +
        (listed ? '' : ' (no Files section yet; audit_architecture({ regenerate: true }) writes it)') +
        `\n${(listed ?? own).join('\n')}`
    );
  }
  if (dirs.length > MAX_LISTED_DOMAINS) out.push(`\n…and ${dirs.length - MAX_LISTED_DOMAINS} more domains: narrow the glob.`);
  if (offMap.length) {
    out.push(
      `\nOn no domain yet:\n${offMap.slice(0, MAX_OFF_MAP_FILES).join('\n')}` +
        (offMap.length > MAX_OFF_MAP_FILES ? `\n…and ${offMap.length - MAX_OFF_MAP_FILES} more: narrow the glob.` : '')
    );
  }
  return out.join('\n');
}

/** search_code's listing for an app that follows Wayfinding; undefined otherwise. */
export function domainListing(app: Pick<AppConfig, 'architecture'>, repoRoot: string): SearchListing | undefined {
  const config = app.architecture;
  if (!config) return undefined;
  return (glob) => listByDomain(repoRoot, listDomains(repoRoot, config), glob);
}
