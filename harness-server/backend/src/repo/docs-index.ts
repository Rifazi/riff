import { promises as fs } from 'node:fs';
import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import { docsDirFor, type AppConfig } from '../apps/apps.js';

export interface DocSection {
  file: string; // repo-relative path, e.g. docs/ingestion/invoices.md
  heading: string; // nearest heading path, e.g. "Ingestion > Invoices > Retry behaviour"
  content: string;
}

interface ScoredSection extends DocSection {
  score: number;
}

// Per app, not global — each app's docs index is built and searched
// independently so search_docs never mixes sections from two different
// target repos.
const sectionsByApp = new Map<string, DocSection[]>();
const indexedAtByApp = new Map<string, number>();
const watchersByApp = new Map<string, FSWatcher>();

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

function splitIntoSections(relPath: string, markdown: string): DocSection[] {
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
  const watcher = chokidar.watch(`${docsDirFor(app)}/**/*.md`, { ignoreInitial: true });
  const reindex = () => {
    buildDocsIndex(app).catch((err) => {
      // eslint-disable-next-line no-console
      console.error(`[docs-index] (${app.id}) failed to reindex`, err);
    });
  };
  watcher.on('add', reindex).on('change', reindex).on('unlink', reindex);
  watchersByApp.set(app.id, watcher);
}

// Full teardown for an app that's actually being removed — unlike
// stopWatching() above, this also drops its cached sections/indexedAt.
export function removeIndex(appId: string): void {
  stopWatching(appId);
  sectionsByApp.delete(appId);
  indexedAtByApp.delete(appId);
}

export function getIndexedAt(appId: string): number {
  return indexedAtByApp.get(appId) ?? 0;
}

export function searchDocs(appId: string, query: string, k = 5): ScoredSection[] {
  const queryTerms = tokenize(query);
  if (queryTerms.length === 0) return [];
  const sections = sectionsByApp.get(appId) ?? [];

  const scored: ScoredSection[] = sections.map((section) => {
    const haystack = tokenize(`${section.heading} ${section.content}`);
    const haystackSet = new Map<string, number>();
    for (const term of haystack) {
      haystackSet.set(term, (haystackSet.get(term) ?? 0) + 1);
    }
    // Length-normalize term-frequency so a single huge, unheaded section
    // (e.g. a legacy dump with no ## headings) can't outscore a small,
    // well-organized section just by sheer word volume.
    const lengthNorm = Math.log2(haystack.length + 2);

    let score = 0;
    for (const term of queryTerms) {
      for (const [word, count] of haystackSet) {
        if (word === term) score += (count * 3) / lengthNorm;
        else if (word.includes(term) || term.includes(word)) score += count / lengthNorm;
      }
      if (section.heading.toLowerCase().includes(term)) score += 5;
    }

    return { ...section, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

export function readDocSection(appId: string, relPath: string): string | null {
  const normalized = relPath.replace(/^\/+/, '');
  const sections = sectionsByApp.get(appId) ?? [];
  const matches = sections.filter((s) => s.file === normalized);
  if (matches.length === 0) return null;
  return matches.map((s) => `## ${s.heading}\n\n${s.content}`).join('\n\n---\n\n');
}

export function listIndexedFiles(appId: string): string[] {
  const sections = sectionsByApp.get(appId) ?? [];
  return [...new Set(sections.map((s) => s.file))].sort();
}
