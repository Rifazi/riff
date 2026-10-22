import matter from 'gray-matter';
import { findingFiles, findingSimilarity, loopBrief, SAME_FINDING, type QaCriterionRecord, type QaLoopAnalysis } from './qa-loop.js';
import type { QaResponse } from './session.js';

export interface ParsedQaReport {
  result: string | null;
  failedChecks: string[];
  blocking: string[];
  notes: string[];
  // The acceptance-criteria checklist: `- [x] <criterion> — <where>` lines.
  criteria: QaCriterionRecord[];
}

const CHECK_LINE = /^- \[( |x|X)\]\s*(.+)$/;

/** The report body's acceptance-criteria checklist, one record per line. */
export function reportCriteria(body: string): QaCriterionRecord[] {
  const out: QaCriterionRecord[] = [];
  for (const raw of body.split('\n')) {
    const m = CHECK_LINE.exec(raw.trim());
    if (!m) continue;
    const rest = m[2].trim();
    // Blocking/note findings use the same bullet shape in older reports.
    if (/^\[(blocking|note|nit)\]/i.test(rest)) continue;
    const text = rest.split(/\s+[—–-]\s+/)[0].trim();
    if (!text) continue;
    out.push({ text, verdict: m[1] === ' ' ? 'not-met' : 'met', files: findingFiles(rest) });
  }
  return out;
}

// Notes the coder can't act on: they describe what QA couldn't do or what the
// human should look at, and coming back every pass they only cost a round.
const NOT_FOR_CODER = [
  /no screenshot tool|screenshot tool (?:was )?(?:not )?available|verified from (?:css|code|jsx)[^.]*only/i,
  /(?:human|you|someone) should (?:eyeball|check visually|look at|review visually)|eyeball /i,
  /\b(?:app|apps page) configuration\b|source[- ]folder setting|\bsrcDirs?\b setting/i,
  /audit_architecture'?s? output was truncated/i,
];

/** Whether the coding agent can do anything about a note. */
export function isActionableNote(note: string): boolean {
  return !NOT_FOR_CODER.some((re) => re.test(note));
}

/** The parts of a QA report that need acting on: result, failing checks, blocking findings and notes. */
export function parseQaReport(raw: string): ParsedQaReport {
  const parsed = matter(raw);
  const d = parsed.data as Record<string, unknown>;
  const failedChecks = (
    [
      ['lint', d.lint],
      ['unit tests', d['unit-tests']],
      ['integration tests', d['integration-tests']],
    ] as const
  )
    .filter(([, v]) => v === 'fail')
    .map(([name]) => name);

  // Reports written before blocking-findings existed: fall back to the
  // unchecked criteria and [blocking] lines the prompt's template produces.
  const listed = Array.isArray(d['blocking-findings']) ? (d['blocking-findings'] as unknown[]).map(String) : null;
  const blocking =
    listed ??
    parsed.content
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^- \[ \]/.test(l) || /^- \[blocking\]/i.test(l))
      .map((l) => l.replace(/^- \[(?: |blocking)\]\s*/i, ''));

  // Older reports have no actionable-notes field: their [nit] lines are the
  // nearest thing.
  const notes = (
    Array.isArray(d['actionable-notes'])
      ? (d['actionable-notes'] as unknown[]).map(String)
      : parsed.content
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => /^- \[(note|nit)\]/i.test(l))
          .map((l) => l.replace(/^- \[(?:note|nit)\]\s*/i, ''))
  ).filter(isActionableNote);

  return {
    result: typeof d.result === 'string' ? d.result : null,
    failedChecks,
    blocking,
    notes,
    criteria: reportCriteria(parsed.content),
  };
}

/**
 * The part of a QA report that needs acting on: result, failing checks, the
 * blocking findings and the non-blocking notes the human sent back (all of them unless some were declined). Used for the send-back relay to the coding agent.
 * With `loop`, it opens with how this branch has been going back and forth.
 */
export function compactQaFindings(
  raw: string,
  loop: QaLoopAnalysis | null = null,
  declinedNotes: string[] = [],
  responses: QaResponse[] = [],
): string {
  const parsed = parseQaReport(raw);
  const { result, failedChecks, blocking } = parsed;
  // Blocking findings always go back; the human picks which non-blocking notes do.
  const notes = parsed.notes.filter((n) => !declinedNotes.includes(n));

  let text = `QA result: ${result ?? '?'}`;
  if (failedChecks.length > 0) text += ` — failing checks: ${failedChecks.join(', ')}`;
  if (loop?.looping) text += `\n\n${loopBrief(loop)}`;
  text += blocking.length > 0 ? `\n\nFix:\n${blocking.map((f, i) => `${i + 1}. ${f}${earlierAnswer(f, responses)}`).join('\n')}` : '\n\nNo blocking findings were listed.';
  if (notes.length > 0) {
    text += `\n\nAlso address (non-blocking, but QA wants these acted on):\n${notes.map((n, i) => `${i + 1}. ${n}`).join('\n')}`;
  }
  if (blocking.length > 0 || notes.length > 0) text += `\n\n${FIX_RULES}`;
  return text;
}

/** What the coder said last time about a blocker that has come back, so it reads QA's reply with its own answer next to it. */
function earlierAnswer(finding: string, responses: QaResponse[]): string {
  const match = [...responses].reverse().find((r) => findingSimilarity(finding, r.finding) >= SAME_FINDING);
  if (!match) return '';
  return `\n   You answered this (${match.status}): ${match.explanation} QA's finding above replies to that: answer it, don't repeat yourself.`;
}

// Two things sent branches back more than once: fixes nothing tested (one
// broke the line it fixed), and notes skipped without a word that the next
// pass made blocking.
export const FIX_RULES =
  'For each blocking finding, fix it and add or change a test that fails without the fix, then call respond_to_qa for every blocker: fixed (the test or file:line that proves it), disputed (why QA is wrong, with the exact line or behaviour) or blocked (what you tried and the exact error). Do not leave one unanswered, and do not answer "already handled" without the line that handles it. For each note, act on ' +
  "it or call note_for_qa saying why you didn't: QA re-checks every note, and one skipped without a reason comes back. " +
  'Before you finish, check each blocker yourself: the lines QA names must be among the lines you changed, and your new test must fail without your change. The pre-QA check refuses a fix that changed none of them.';
