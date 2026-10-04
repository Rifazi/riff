import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { selectSections, splitIntoSections } from '../repo/docs-index.js';

// The target repo's own agent instructions. Claude Code used to load this
// file into every request of every agent (settingSources: ['project']),
// which in a large repo was ~8k tokens per request whether or not the step
// touched what it describes. Agents now get its headings and read the
// sections they need with read_doc.
export const REPO_INSTRUCTIONS_FILE = 'CLAUDE.md';

function readInstructions(repoRoot: string): string | null {
  const file = path.join(repoRoot, REPO_INSTRUCTIONS_FILE);
  if (!existsSync(file)) return null;
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** A system-prompt section pointing at the repo's CLAUDE.md, or '' when it has none. */
export function repoInstructionsNote(repoRoot: string): string {
  const markdown = readInstructions(repoRoot);
  if (!markdown?.trim()) return '';
  // Its top-level sections as splitIntoSections sees them (code fences
  // skipped), under the file's single `#` title when it has one.
  const paths = splitIntoSections(REPO_INSTRUCTIONS_FILE, markdown).map((s) => s.heading.split(' > '));
  const titled = paths.length > 1 && paths.every((p) => p[0] === paths[0][0]);
  const headings = [...new Set(paths.map((p) => (titled ? p[1] : p[0])).filter(Boolean))].map((h) => `- ${h}`);
  return (
    `\n\n# Repo instructions (${REPO_INSTRUCTIONS_FILE})\n\nThe repo has a ${REPO_INSTRUCTIONS_FILE} with its own ` +
    `conventions for agents working in it (${markdown.length.toLocaleString()} characters). It isn't loaded ` +
    `automatically. Before working in an area it covers, read that section with read_doc({ path: ` +
    `"${REPO_INSTRUCTIONS_FILE}", heading: "<heading>" }); search_docs won't find it.` +
    (headings.length > 0 ? ` Its sections:\n\n${headings.join('\n')}` : '')
  );
}

/** read_doc for CLAUDE.md: the whole file, or the section under `heading`. */
export function readRepoInstructions(repoRoot: string, heading?: string): string {
  const markdown = readInstructions(repoRoot);
  if (markdown === null) throw new Error(`This repo has no ${REPO_INSTRUCTIONS_FILE}.`);
  if (!heading) return markdown;
  const sections = splitIntoSections(REPO_INSTRUCTIONS_FILE, markdown);
  // Headings are paths ("CLAUDE.md > Search > Engine"); also accept a
  // heading without its parents, as the note lists them.
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
  const matches = selectSections(sections, REPO_INSTRUCTIONS_FILE, prefix) ?? [];
  return matches.map((s) => `## ${s.heading}\n\n${s.content}`).join('\n\n---\n\n');
}
