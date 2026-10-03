import { promises as fs } from 'node:fs';
import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import { docsDirFor, type AppConfig } from '../apps/apps.js';
import { fingerprint, forgetScope, syncScope, type SearchDocument } from '../search/search-engine.js';

export interface DocSection {
  file: string; // repo-relative path, e.g. docs/ingestion/invoices.md
  heading: string; // nearest heading path, e.g. "Ingestion > Invoices > Retry behaviour"
  content: string;
}

// Per app, not global — each app's docs index is built and searched
// independently so search_docs never mixes sections from two different
// target repos. The sections serve read_doc; searching them is Riff's
// search engine's job (search/search-engine.ts), fed from searchDocsByApp.
const sectionsByApp = new Map<string, DocSection[]>();
const searchDocsByApp = new Map<string, SearchDocument[]>();
const indexedAtByApp = new Map<string, number>();
const watchersByApp = new Map<string, FSWatcher>();

export function splitIntoSections(relPath: string, markdown: string): DocSection[] {
  const lines = markdown.split('\n');
  const result: DocSection[] = [];
  const headingStack: { level: number; text: string }[] = [];
  let currentContent: string[] = [];

  const flush = () => {
    const content = currentContent.join('\n').trim();
    if (content.length > 0) {
      const headingPath = headingStack.map((h) => h.text).join(' > ') || path.basename(relPath);
      result.push({ file: relPath, heading: headingPath, content });
    }
    currentContent = [];
  };

  for (const line of lines) {
    const match = /^(#{1,6})\s+(.*)$/.exec(line);
    if (match) {
      flush();
      const level = match[1].length;
      while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= level) {
        headingStack.pop();
      }
      headingStack.push({ level, text: match[2].trim() });
    } else {
      currentContent.push(line);
    }
  }
  flush();

  return result;
}

async function walkMarkdownFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkMarkdownFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(full);
    }
  }
  return files;
}

export async function buildDocsIndex(app: AppConfig): Promise<void> {
  const docsDir = docsDirFor(app);
  const files = await walkMarkdownFiles(docsDir).catch(() => [] as string[]);
  const nextSections: DocSection[] = [];
  for (const absPath of files) {
    const relPath = path.relative(app.repoRoot, absPath);
    const content = await fs.readFile(absPath, 'utf8');
    nextSections.push(...splitIntoSections(relPath, content));
  }
  sectionsByApp.set(app.id, nextSections);
  searchDocsByApp.set(app.id, toSearchDocuments(nextSections, 'doc'));
  indexedAtByApp.set(app.id, Date.now());
  // eslint-disable-next-line no-console
  console.log(`[docs-index] (${app.id}) indexed ${nextSections.length} sections from ${files.length} files`);
}

// Only tears down this app's file watcher — used before starting a
// replacement one (e.g. after a repoRoot edit) — and deliberately leaves
// sectionsByApp/indexedAtByApp alone. Calling this right after
// buildDocsIndex() (as every app-create/update call site does) must not
// wipe the index that call just populated; use removeIndex() below for an
// actual app deletion, which needs both torn down.
export function stopWatching(appId: string): void {
  const watcher = watchersByApp.get(appId);
  if (watcher) {
    void watcher.close();
    watchersByApp.delete(appId);
  }
}

export function watchDocsForChanges(app: AppConfig): void {
  stopWatching(app.id);
  // chokidar 4 dropped glob support (a `**/*.md` pattern watches nothing),
  // so watch the directory and ignore files that aren't markdown.
  const watcher = chokidar.watch(docsDirFor(app), {
    ignoreInitial: true,
    ignored: (p, stats) => !!stats?.isFile() && !p.endsWith('.md'),
  });
  const reindex = () => {
    buildDocsIndex(app).catch((err) => {
      // eslint-disable-next-line no-console
      console.error(`[docs-index] (${app.id}) failed to reindex`, err);
    });
  };
  watcher.on('add', reindex).on('change', reindex).on('unlink', reindex);
  watchersByApp.set(app.id, watcher);
}

/** Closes every docs watcher (server shutdown). */
export async function stopAllWatching(): Promise<void> {
  const watchers = [...watchersByApp.values()];
  watchersByApp.clear();
  await Promise.allSettled(watchers.map((w) => w.close()));
}

// Full teardown for an app that's actually being removed — unlike
// stopWatching() above, this also drops its cached sections/indexedAt.
export function removeIndex(appId: string): void {
  stopWatching(appId);
  sectionsByApp.delete(appId);
  searchDocsByApp.delete(appId);
  indexedAtByApp.delete(appId);
  forgetScope(docsSearchScope(appId));
}

export function getIndexedAt(appId: string): number {
  return indexedAtByApp.get(appId) ?? 0;
}

export function docsSearchScope(appId: string): string {
  return `app:${appId}:docs`;
}

/** Brings the search engine's copy of this app's docs up to date (cheap when nothing changed). */
export function syncDocsSearch(appId: string): Promise<void> {
  return syncScope(docsSearchScope(appId), searchDocsByApp.get(appId) ?? []);
}

// One search document per file; each section is a segment, so a hit's
// heading is exactly what read_doc takes. Shared with
// sessions/reference-docs.ts.
export function toSearchDocuments(sections: DocSection[], kind: string): SearchDocument[] {
  const byFile = new Map<string, DocSection[]>();
  for (const section of sections) byFile.set(section.file, [...(byFile.get(section.file) ?? []), section]);
  return [...byFile].map(([file, fileSections]) => ({
    key: file,
    kind,
    title: file,
    fingerprint: fingerprint(JSON.stringify(fileSections)),
    segments: fileSections.map((s) => ({ text: s.content, heading: s.heading })),
  }));
}

/**
 * The whole file, or with `heading` just that section and everything nested
 * under it (headings are paths, e.g. "Ingestion > Invoices"). Throws, listing
 * the file's headings, when `heading` matches nothing.
 */
export function readDocSection(appId: string, relPath: string, heading?: string): string | null {
  const matches = selectSections(sectionsByApp.get(appId) ?? [], relPath, heading);
  return matches && matches.map((s) => `## ${s.heading}\n\n${s.content}`).join('\n\n---\n\n');
}

// The sections readDocSection returns, before joining — null when the file
// isn't indexed at all.
export function selectSections(sections: DocSection[], relPath: string, heading?: string): DocSection[] | null {
  const normalized = relPath.replace(/^\/+/, '');
  let matches = sections.filter((s) => s.file === normalized);
  if (matches.length === 0) return null;
  if (heading) {
    const wanted = heading.trim().toLowerCase();
    const inSection = matches.filter((s) => {
      const h = s.heading.toLowerCase();
      // "(part n of m)": a long heading-less section split by reference-docs.ts.
      return h === wanted || h.startsWith(`${wanted} > `) || h.startsWith(`${wanted} (part `);
    });
    if (inSection.length === 0) {
      throw new Error(
        `No section "${heading}" in ${normalized}. Its headings:\n${matches.map((s) => `- ${s.heading}`).join('\n')}`
      );
    }
    matches = inSection;
  }
  return matches;
}

export function listIndexedFiles(appId: string): string[] {
  const sections = sectionsByApp.get(appId) ?? [];
  return [...new Set(sections.map((s) => s.file))].sort();
}
