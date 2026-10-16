import { promises as fs } from 'node:fs';
import path from 'node:path';
import { listRepoFiles } from '../repo/git.js';
import type { QaRoundRecord } from '../sessions/qa-loop.js';

/**
 * A QA fix works on the files QA named, not the whole branch. The findings
 * name files and lines; this turns them into a write scope for the coder's
 * tools and the code they point at, so the fix starts from the right lines
 * instead of re-reading the branch.
 */

export interface FindingRef {
  path: string;
  lines: [number, number] | null;
}

export interface ScopedFinding {
  kind: 'blocking' | 'note';
  text: string;
  refs: FindingRef[];
}

export interface FixScopeInfo {
  // Repo-relative files the findings name (resolved to existing files).
  paths: string[];
  findings: ScopedFinding[];
  // Every blocking finding named at least one file: the write tools are fenced to `paths`.
  fenced: boolean;
}

const EXT = 'tsx?|jsx?|mjs|cjs|mdx?|json|ya?ml|toml|css|scss|less|html|vue|svelte|py|rs|go|java|kt|rb|php|cs|sql|sh|txt';
const PATH_RE = new RegExp(`(?:[\\w@.\\-]+/)*[\\w.\\-]+\\.(?:${EXT})\\b(?::(\\d+)(?:-(\\d+))?)?`, 'g');
// "(~line 33-65)", "line ~200", "lines 220-230", right after the path.
const LINE_HINT = /(?:~\s*)?lines?\s*~?\s*(\d+)(?:\s*[-–]\s*(\d+))?/i;

/** The file references a finding makes, with any line or range it gives. */
export function findingRefs(text: string): FindingRef[] {
  const refs: FindingRef[] = [];
  const seen = new Set<string>();
  const matches = [...text.matchAll(PATH_RE)];
  matches.forEach((m, i) => {
    const full = m[0];
    const file = full.replace(/:\d+(-\d+)?$/, '');
    if (!/[a-z]/i.test(file.split('/').pop()!.split('.')[0])) return;
    let lines: [number, number] | null = m[1] ? [Number(m[1]), Number(m[2] ?? m[1])] : null;
    if (!lines) {
      const next = matches[i + 1]?.index ?? text.length;
      const after = text.slice(m.index! + full.length, Math.min(next, m.index! + full.length + 60));
      const hint = LINE_HINT.exec(after);
      if (hint) lines = [Number(hint[1]), Number(hint[2] ?? hint[1])];
    }
    const key = `${file}:${lines?.join('-') ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push({ path: file, lines });
  });
  return refs;
}

/** A finding's path as a repo file: as written, or a bare file name that matches one tracked file. */
function resolveRef(ref: FindingRef, repoFiles: string[]): FindingRef | null {
  if (repoFiles.includes(ref.path)) return ref;
  const name = ref.path.split('/').pop()!;
  const candidates = repoFiles.filter((f) => f.endsWith(`/${name}`) || f === name);
  // A partial path narrows it ("lib/validator.ts" among several validator.ts).
  const narrowed = ref.path.includes('/') ? candidates.filter((f) => f.endsWith(`/${ref.path}`)) : candidates;
  const pick = narrowed.length === 1 ? narrowed : candidates.length === 1 ? candidates : [];
  return pick.length === 1 ? { ...ref, path: pick[0] } : null;
}

/** The scope and references of a QA pass's findings. Null without findings. */
export async function fixScopeFor(repoRoot: string, round: QaRoundRecord | undefined): Promise<FixScopeInfo | null> {
  if (!round || (round.blocking.length === 0 && round.notes.length === 0)) return null;
  const repoFiles = await listRepoFiles(repoRoot).catch(() => [] as string[]);
  const resolve = (kind: 'blocking' | 'note') => (text: string): ScopedFinding => ({
    kind,
    text,
    refs: findingRefs(text)
      .map((r) => resolveRef(r, repoFiles))
      .filter((r): r is FindingRef => r !== null),
  });
  const findings = [...round.blocking.map(resolve('blocking')), ...round.notes.map(resolve('note'))];
  const paths = [...new Set(findings.flatMap((f) => f.refs.map((r) => r.path)))];
  const blockers = findings.filter((f) => f.kind === 'blocking');
  const fenced = blockers.length > 0 && blockers.every((f) => f.refs.length > 0);
  return { paths, findings, fenced };
}

const TEST_DIRS = new Set(['__tests__', '__fixtures__', 'fixtures', 'tests', 'test']);
const stem = (file: string) => path.basename(file).split('.')[0].toLowerCase();

/**
 * Whether a write lands in the fix scope: a named file, anything under a
 * named folder, or a test, spec or fixture next to a named file.
 */
export function inFixScope(relPath: string, scope: string[]): boolean {
  const rel = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
  const dir = path.posix.dirname(rel);
  const base = path.posix.basename(rel).toLowerCase();
  return scope.some((s) => {
    if (rel === s || rel.startsWith(`${s}/`)) return true;
    const sDir = path.posix.dirname(s);
    const sibling = dir === sDir || (path.posix.dirname(dir) === sDir && TEST_DIRS.has(path.posix.basename(dir)));
    if (!sibling) return false;
    const isTest = /\.(test|spec)\./.test(base) || TEST_DIRS.has(path.posix.basename(dir));
    return isTest && base.startsWith(stem(s));
  });
}

export const FIX_SCOPE_CHARS = 8_000;
const CONTEXT_LINES = 8;
const MAX_REF_LINES = 50;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The lines each finding points at, read from disk, for the coder's first fix message. */
export async function fixContext(repoRoot: string, scope: FixScopeInfo): Promise<string> {
  const parts: string[] = [];
  let used = 0;
  const files = new Map<string, string[]>();
  const linesOf = async (file: string) => {
    let lines = files.get(file);
    if (!lines) {
      lines = (await fs.readFile(path.join(repoRoot, file), 'utf8').catch(() => '')).split('\n');
      files.set(file, lines);
    }
    return lines;
  };
  for (const [i, finding] of scope.findings.entries()) {
    const label = finding.kind === 'blocking' ? `Blocking ${i + 1}` : `Note ${i + 1 - scope.findings.filter((f) => f.kind === 'blocking').length}`;
    let part = `**${label}:** ${clip(finding.text, 300)}`;
    for (const ref of finding.refs) {
      const lines = await linesOf(ref.path);
      if (lines.length <= 1 && !lines[0]) {
        part += `\n- ${ref.path} (unreadable)`;
        continue;
      }
      if (!ref.lines) {
        part += `\n- ${ref.path} (${lines.length} lines; read_file the range you need)`;
        continue;
      }
      if (ref.lines[0] > lines.length) {
        part += `\n- ${ref.path}: line ${ref.lines[0]} is past the end (${lines.length} lines); read_file the part you need`;
        continue;
      }
      const from = Math.max(1, ref.lines[0] - CONTEXT_LINES);
      const to = Math.min(lines.length, Math.max(ref.lines[1], ref.lines[0]) + CONTEXT_LINES, from + MAX_REF_LINES - 1);
      const width = String(to).length;
      const body = lines
        .slice(from - 1, to)
        .map((l, j) => `${String(from + j).padStart(width)} | ${l}`)
        .join('\n');
      part += `\n- ${ref.path}:${from}-${to}\n\`\`\`\n${body}\n\`\`\``;
    }
    if (used + part.length > FIX_SCOPE_CHARS) {
      parts.push(`(${scope.findings.length - i} more findings: see the message below.)`);
      break;
    }
    parts.push(part);
    used += part.length;
  }
  const fence = scope.fenced
    ? `Your write tools accept only these files, and tests or fixtures next to them:\n${scope.paths.map((p) => `- ${p}`).join('\n')}\n\n` +
      'If a fix genuinely needs another file, call widen_fix_scope with the path and why; QA sees the reason.'
    : 'Change only what the findings need: every extra change is more for QA to re-check.';
  return `# What QA points at\n\nThe code each finding names, as it is now. Start from these lines; don't re-read the branch.\n\n${parts.join('\n\n')}\n\n${fence}`;
}
