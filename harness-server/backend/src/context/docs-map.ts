import { createHash } from 'node:crypto';

export type MapRole = 'requirements' | 'plan' | 'coding' | 'qa';

export interface DocEntry {
  path: string;
  hash: string;
  summary: string;
  by: 'local' | 'rule';
}

const MAX_SUMMARY_CHARS = 280;
const MAP_CHARS: Record<MapRole, number> = { requirements: 4500, plan: 4500, coding: 2200, qa: 2200 };

export const hashText = (text: string) => createHash('sha1').update(text).digest('hex').slice(0, 12);

function stripMarkdown(line: string): string {
  return line
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** What a doc says in one line, taken from its text: the title and its first sentence. */
export function ruleSummary(markdown: string): string {
  const lines = markdown.replace(/^---\n[\s\S]*?\n---\n/, '').split('\n');
  let inFence = false;
  let title = '';
  let sentence = '';
  for (const raw of lines) {
    if (/^\s*```/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const line = raw.trim();
    if (!line) continue;
    if (/^#{1,6}\s/.test(line)) {
      if (!title) title = stripMarkdown(line);
      continue;
    }
    if (/^(\||[-*+]\s|\d+\.\s|<)/.test(line)) continue;
    sentence = stripMarkdown(line);
    if (sentence) break;
  }
  const first = sentence.match(/^.*?[.!?](\s|$)/)?.[0].trim() ?? sentence;
  const text = [title, first && first !== title ? first : ''].filter(Boolean).join(' — ');
  return text.length > MAX_SUMMARY_CHARS ? `${text.slice(0, MAX_SUMMARY_CHARS - 1).trimEnd()}…` : text;
}

/** A model's reply as a one-line summary, or null when it's empty or just echoes an instruction. */
export function cleanModelSummary(raw: string): string | null {
  const text = raw
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/^\s*(summary|here is[^:\n]*)\s*:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length < 12) return null;
  return text.length > MAX_SUMMARY_CHARS ? `${text.slice(0, MAX_SUMMARY_CHARS - 1).trimEnd()}…` : text;
}

/** Changes when a doc is added, removed or edited, not when a summary is improved. */
export function docsMapFingerprint(entries: readonly DocEntry[]): string {
  if (entries.length === 0) return 'none';
  return hashText(entries.map((e) => `${e.path}:${e.hash}`).join('|'));
}

/**
 * The docs map as a prompt section. Docs the requirements cite or ask to be
 * updated come first; the rest follow in path order until the role's budget
 * runs out, and the count left out is stated so agents know to search.
 */
export function renderDocsMap(entries: readonly DocEntry[], role: MapRole, cited: readonly string[] = []): string {
  if (entries.length === 0) return '';
  const isCited = (e: DocEntry) => cited.some((c) => c === e.path || e.path.endsWith(`/${c}`));
  const ordered = [...entries.filter(isCited), ...entries.filter((e) => !isCited(e))];
  const budget = MAP_CHARS[role];
  const lines: string[] = [];
  let used = 0;
  for (const e of ordered) {
    const line = `- ${e.path} — ${e.summary}`;
    if (used + line.length > budget && lines.length > 0) break;
    lines.push(line);
    used += line.length + 1;
  }
  const left = ordered.length - lines.length;
  return (
    `\n\n# Docs map\n\nOne line per doc in the repo's docs, kept current by Riff, so you know which to open before ` +
    `searching. Read one with read_doc; search_docs finds sections inside them. Docs the requirements cite or ` +
    `ask to update are listed first.\n\n${lines.join('\n')}` +
    (left > 0 ? `\n- … and ${left} more: use search_docs.` : '')
  );
}
