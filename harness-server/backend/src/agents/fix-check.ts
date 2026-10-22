import { inFixScope, type FixScopeInfo, type ScopedFinding } from './fix-scope.js';

export interface Hunk {
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const TEST_FILE = /(?:\.(?:test|spec)\.[a-z]+$)|(?:^|\/)(?:__tests__|tests?|__fixtures__|fixtures)\//i;
const NEAR_LINES = 10;

/** The hunks of a zero-context diff, per file (the new path; a deleted file is keyed by its old one). */
export function parseHunks(diff: string): Map<string, Hunk[]> {
  const out = new Map<string, Hunk[]>();
  let file: string | null = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)/.exec(line);
      file = m ? m[2] : null;
      if (file && !out.has(file)) out.set(file, []);
    } else if (file) {
      const h = HUNK.exec(line);
      if (!h) continue;
      const oldLen = h[2] === undefined ? 1 : Number(h[2]);
      const newLen = h[4] === undefined ? 1 : Number(h[4]);
      out.get(file)!.push({
        oldStart: Number(h[1]),
        oldEnd: Number(h[1]) + Math.max(oldLen, 1) - 1,
        newStart: Number(h[3]),
        newEnd: Number(h[3]) + Math.max(newLen, 1) - 1,
      });
    }
  }
  return out;
}

function touches(hunks: Hunk[], [from, to]: [number, number]): boolean {
  const lo = from - NEAR_LINES;
  const hi = to + NEAR_LINES;
  return hunks.some((h) => (h.oldStart <= hi && h.oldEnd >= lo) || (h.newStart <= hi && h.newEnd >= lo));
}

const clip = (s: string, n = 160) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * What the fix pass did not do. QA names a file and lines for each blocker;
 * a fix that never touched them can't have fixed it (session cases: the same
 * blocker back three times after fixes elsewhere in the file), and a fix with
 * no test change is how a fix breaks the line it fixed. Findings that name no
 * file are skipped, since nothing can be checked against them.
 */
export function fixCheckProblems(
  scope: FixScopeInfo | null,
  diff: string,
  notes: string[] = [],
  // The coder's respond_to_qa answers for this pass; undefined skips the rule that every blocker needs one.
  responses?: { blocker: number; status: 'fixed' | 'disputed' | 'blocked' }[],
): string[] {
  if (!scope) return [];
  const hunks = parseHunks(diff);
  const blockers = scope.findings.filter((f) => f.kind === 'blocking');
  const problems: string[] = [];
  // The error tells the coder it can say in note_for_qa why a spot is wrong,
  // so a note that names the blocker's file answers it (QA then re-checks).
  const answered = (f: ScopedFinding) => f.refs.length > 0 && notes.some((n) => f.refs.some((r) => n.includes(r.path) || n.includes(r.path.split('/').pop()!)));
  let unanswered = 0;
  blockers.forEach((f, i) => {
    const response = responses?.find((r) => r.blocker === i + 1);
    if (responses && !response) {
      problems.push(
        `Blocking ${i + 1} has no answer: "${clip(f.text)}". Call respond_to_qa for it: fixed (with the test or file:line that proves it), ` +
          'disputed (why QA is wrong, with the exact line or behaviour) or blocked (what you tried and the exact error).',
      );
      return;
    }
    // A dispute or a blocked fix is QA's to rule on; only a claimed fix is checked against the diff.
    if (response && response.status !== 'fixed') return;
    if (f.refs.length === 0) return;
    if (answered(f)) return;
    unanswered++;
    // A blocker that asks for a test is fixed in the test next to the file it names, not at those lines.
    const hit = f.refs.some((r) => {
      const h = hunks.get(r.path);
      if (h && (r.lines ? touches(h, r.lines) : true)) return true;
      return /\btests?\b/i.test(f.text) && [...hunks.keys()].some((file) => file !== r.path && TEST_FILE.test(file) && inFixScope(file, [r.path]));
    });
    if (hit) return;
    const where = f.refs.map((r) => `${r.path}${r.lines ? `:${r.lines[0]}${r.lines[1] !== r.lines[0] ? `-${r.lines[1]}` : ''}` : ''}`).join(', ');
    problems.push(
      `Blocking ${i + 1} points at ${where}, and nothing there changed since QA's pass, so it can't be fixed yet: "${clip(f.text)}". ` +
        'Fix it where QA points (or say in note_for_qa why that spot is wrong).'
    );
  });
  const changed = [...hunks.keys()];
  if (unanswered > 0 && changed.length > 0 && !changed.some((f) => TEST_FILE.test(f))) {
    problems.push('The fix changed no test. Add or change a test that fails without each blocking fix.');
  }
  return problems;
}
