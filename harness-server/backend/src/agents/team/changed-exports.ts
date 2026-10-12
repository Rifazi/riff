import { outlineText } from '../tool-defs/outline-tool.js';
import { diffAgainstBase, showFileAt } from '../../repo/git.js';

// The exported declarations a workstream's branch adds or changes, one line
// each, so the lead and the workstreams that depend on it learn its API
// without reading its files. Built from outline_file's outline, no model.

export const MAX_EXPORT_LINES = 40;
const MAX_LINE_CHARS = 200;
const CODE_FILE = /\.(c|m)?[jt]sx?$/;
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

/** The new-side line ranges each file's hunks touch, from a `--unified=0` diff. */
export function changedRanges(diff: string): Map<string, [number, number][]> {
  const out = new Map<string, [number, number][]>();
  let file: string | null = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      file = line === '+++ /dev/null' ? null : line.slice(4).replace(/^b\//, '');
      if (file) out.set(file, []);
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk && file) {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      // A pure deletion (count 0) sits between two lines: count the next one.
      out.get(file)!.push([start, start + Math.max(count, 1) - 1]);
    }
  }
  return out;
}

/** The top-level exported entries of an outline whose lines overlap a changed range. */
export function exportsTouched(outline: string[], ranges: [number, number][]): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  for (const entry of outline) {
    const m = /^(\d+)(?:-(\d+))?  (export\b.*)$/.exec(entry);
    if (!m) continue;
    const start = Number(m[1]);
    const end = m[2] ? Number(m[2]) : start;
    if (ranges.some(([a, b]) => a <= end && b >= start)) {
      const text = m[3].length > MAX_LINE_CHARS ? `${m[3].slice(0, MAX_LINE_CHARS)}…` : m[3];
      out.push({ line: start, text });
    }
  }
  return out;
}

/** "path:line  export …" lines, capped at MAX_EXPORT_LINES with a count of the rest. */
export function formatExports(byFile: { path: string; entries: { line: number; text: string }[] }[]): string[] {
  const all = byFile.flatMap(({ path, entries }) => entries.map((e) => `${path}:${e.line}  ${e.text}`));
  if (all.length <= MAX_EXPORT_LINES) return all;
  return [...all.slice(0, MAX_EXPORT_LINES), `… and ${all.length - MAX_EXPORT_LINES} more`];
}

export async function changedExports(repoRoot: string, branch: string, baseBranch: string): Promise<string[]> {
  const ranges = changedRanges(await diffAgainstBase(repoRoot, branch, baseBranch, [], 0));
  const byFile: { path: string; entries: { line: number; text: string }[] }[] = [];
  for (const [file, fileRanges] of ranges) {
    if (!CODE_FILE.test(file) || TEST_FILE.test(file)) continue;
    let content: string;
    try {
      content = await showFileAt(repoRoot, branch, file);
    } catch {
      continue;
    }
    const entries = exportsTouched(outlineText(content, file), fileRanges);
    if (entries.length) byFile.push({ path: file, entries });
  }
  return formatExports(byFile);
}
