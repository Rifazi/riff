/**
 * QA ↔ coding loops. Every QA pass is kept as a QaRoundRecord; comparing the
 * latest failing pass with the earlier ones says why the branch keeps coming
 * back, and whether another full round is the right move. Pure: the git and
 * session side is in qa-rounds.ts.
 */

import type { QaResponse } from './session.js';

export interface QaCriterionRecord {
  text: string;
  verdict: 'met' | 'not-met' | 'unverified';
  // File names (no folders) the verdict's note pointed at: where the criterion's code is.
  files: string[];
}

export interface QaRoundRecord {
  // 1 = the first review; each re-review after fixes is the next pass.
  pass: number;
  at: string;
  result: string | null;
  blocking: string[];
  notes: string[];
  // The branch commit the pass reviewed. Null when it couldn't be read.
  head: string | null;
  // Every acceptance criterion's verdict, when the report's checklist had them.
  criteria?: QaCriterionRecord[];
  // This pass's copy of the report (harnessRoot-relative): the report file is
  // rewritten every pass, and the QA tab lets the human open earlier ones.
  reportPath?: string;
}

// repeated: an earlier pass blocked on the same thing, so the fix didn't hold.
// was-note: an earlier pass listed it as a note and the fix skipped it.
// in-fix: new, in a file the last fix changed, so the fix broke it.
// missed: new, in code earlier passes reviewed and let through.
export type BlockerKind = 'repeated' | 'was-note' | 'in-fix' | 'missed';

export interface ClassifiedBlocker {
  text: string;
  kind: BlockerKind;
  earlierPass: number | null;
}

export interface QaLoopAnalysis {
  pass: number;
  // Failing passes in a row, ending with the latest.
  failedInARow: number;
  blockers: ClassifiedBlocker[];
  looping: boolean;
  reasons: string[];
  // Few enough blockers that a team round or a full re-review costs more than the fix.
  smallFix: boolean;
}

export const SMALL_FIX_BLOCKERS = 2;
// A re-review with at most this many criteria to re-check is done by the lead alone.
export const SMALL_RECHECK = 3;
// Blockers plus notes a QA fix can have and still be built solo without asking.
const SMALL_FIX_ITEMS = 5;
// A re-review of a fix touching at most this many files is done by the lead alone.
export const SMALL_DELTA_FILES = 8;

const STOPWORDS = new Set(
  (
    'the and that this with from into when then than they them their there here have has had does done ' +
    'only also still just more most such each every some none line lines file files code test tests should ' +
    'would could must make made uses used using add adds added change changed changes instead because which ' +
    'what where while shows show renders render returns return case cases value values previous unfixed filed'
  ).split(' '),
);

// File extensions, so `node.other` or `ctt.elements` aren't read as files.
const PATH_RE =
  /[\w@.\-/]*[\w-]\.(?:tsx?|jsx?|mjs|cjs|mdx?|json|ya?ml|toml|css|scss|less|html|vue|svelte|py|rs|go|java|kt|rb|php|cs|sql|sh|txt)\b/gi;

/** The file names a finding mentions, in order, without folders or line numbers. */
export function findingFiles(text: string): string[] {
  return [...new Set((text.match(PATH_RE) ?? []).map((p) => p.split('/').pop()!.toLowerCase()))];
}

function findingWords(text: string): Set<string> {
  const withoutPaths = text.replace(PATH_RE, ' ');
  return new Set(
    withoutPaths
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((w) => w.length >= 4 && !STOPWORDS.has(w) && !/^\d+$/.test(w)),
  );
}

/**
 * How alike two findings are, 0-1: word overlap, a little more when both are
 * about the same file, and nothing when they name no file in common.
 */
export function findingSimilarity(a: string, b: string): number {
  const fa = findingFiles(a);
  const fb = findingFiles(b);
  if (fa.length > 0 && fb.length > 0 && !fa.some((f) => fb.includes(f))) return 0;
  // Only the file each is about counts: a finding often names others in passing.
  const sameFile = fa.length > 0 && fa[0] === fb[0];
  const wa = findingWords(a);
  const wb = findingWords(b);
  if (wa.size === 0 || wb.size === 0) return 0;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  const overlap = shared / Math.min(wa.size, wb.size);
  return sameFile ? Math.min(1, overlap + 0.25) : overlap;
}

// Calibrated on session 7bdd0d9e's findings: the same issue across passes
// scored 0.7-1, different bugs in the same function up to 0.61.
export const SAME_FINDING = 0.7;

function earlierMatch(text: string, rounds: QaRoundRecord[], pick: (r: QaRoundRecord) => string[]): number | null {
  for (let i = rounds.length - 1; i >= 0; i--) {
    if (pick(rounds[i]).some((f) => findingSimilarity(text, f) >= SAME_FINDING)) return rounds[i].pass;
  }
  return null;
}

/**
 * Why the latest pass failed, compared with the earlier ones. `fixFiles` are
 * the files changed between the previous pass's head and the latest's (null
 * when unknown). Null when there's no failing pass to look at.
 */
export function analyzeQaLoop(rounds: QaRoundRecord[], fixFiles: string[] | null): QaLoopAnalysis | null {
  const latest = rounds[rounds.length - 1];
  if (!latest || latest.result !== 'fail') return null;
  const earlier = rounds.slice(0, -1);

  let failedInARow = 0;
  for (let i = rounds.length - 1; i >= 0 && rounds[i].result === 'fail'; i--) failedInARow++;

  const fixNames = new Set((fixFiles ?? []).map((f) => f.split('/').pop()!.toLowerCase()));
  const blockers: ClassifiedBlocker[] = latest.blocking.map((text) => {
    const repeated = earlierMatch(text, earlier, (r) => r.blocking);
    if (repeated !== null) return { text, kind: 'repeated', earlierPass: repeated };
    const wasNote = earlierMatch(text, earlier, (r) => r.notes);
    if (wasNote !== null) return { text, kind: 'was-note', earlierPass: wasNote };
    const file = findingFiles(text)[0];
    if (earlier.length > 0 && file && fixNames.has(file)) return { text, kind: 'in-fix', earlierPass: null };
    return { text, kind: 'missed', earlierPass: null };
  });

  const count = (kind: BlockerKind) => blockers.filter((b) => b.kind === kind).length;
  const reasons: string[] = [];
  if (failedInARow >= 2) reasons.push(`QA has failed ${failedInARow} passes in a row.`);
  if (count('repeated')) reasons.push(`${plural(count('repeated'), 'blocker')} came back after an earlier fix: the fix didn't hold.`);
  if (count('was-note')) reasons.push(`${plural(count('was-note'), 'blocker')} started as a note that the fix skipped.`);
  if (count('in-fix')) reasons.push(`${plural(count('in-fix'), 'blocker')} ${count('in-fix') === 1 ? 'is' : 'are'} in code the last fix changed.`);
  if (earlier.length > 0 && count('missed')) {
    reasons.push(`${plural(count('missed'), 'blocker')} ${count('missed') === 1 ? 'is' : 'are'} new, in code earlier passes let through.`);
  }

  const looping = failedInARow >= 3 || (failedInARow >= 2 && count('repeated') + count('was-note') + count('in-fix') > 0);
  return {
    pass: latest.pass,
    failedInARow,
    blockers,
    looping,
    reasons,
    smallFix: latest.blocking.length > 0 && latest.blocking.length <= SMALL_FIX_BLOCKERS,
  };
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** Files that blockers named in more than one pass, most often first (basenames are compared, so a bare name and a path match). */
export function hotBlockerFiles(rounds: QaRoundRecord[]): string[] {
  const passes = new Map<string, Set<number>>();
  for (const r of rounds) {
    for (const text of r.blocking) {
      for (const f of findingFiles(text)) {
        if (!passes.has(f)) passes.set(f, new Set());
        passes.get(f)!.add(r.pass);
      }
    }
  }
  return [...passes].filter(([, p]) => p.size >= 2).sort((a, b) => b[1].size - a[1].size).map(([f]) => f);
}

const KIND_LABEL: Record<BlockerKind, string> = {
  repeated: 'flagged before, fix didn\'t hold',
  'was-note': 'was a note you skipped',
  'in-fix': 'in code the last fix changed',
  missed: 'new',
};

/** For the coding agent's QA-fix message when the branch is looping. */
export function loopBrief(loop: QaLoopAnalysis): string {
  const lines = loop.blockers.map((b) => `- (${KIND_LABEL[b.kind]}) ${b.text}`);
  return (
    `This branch keeps coming back from QA. ${loop.reasons.join(' ')}\n` +
    `${lines.join('\n')}\n` +
    'Fix exactly what is listed, prove each fix with a test, and change nothing else: every extra change is more ' +
    'for QA to re-check.'
  );
}

/** Why Bridget stops, and what the human could do instead of another full round. */
export function loopStopReason(loop: QaLoopAnalysis): string {
  const advice = loop.smallFix
    ? `What's left is small (${plural(loop.blockers.length, 'blocking finding')}). Sending it back runs one solo fix and a ` +
      'QA pass on just that fix; or fix it by hand and mark it reviewed.'
    : "Read the report before sending it back: the same areas keep failing, so the requirements or the plan may be what's wrong.";
  return `QA failed the branch again. ${loop.reasons.join(' ')} ${advice}`;
}

const baseName = (f: string) => f.split('/').pop()!.toLowerCase();

/**
 * Which of the last pass's criteria a re-review must check again, and which
 * it carries forward: a criterion met last pass whose code the fix didn't
 * touch is still met. Unknown code (no files on record) or an unknown fix
 * (null) means re-check.
 */
export function carryForward(
  previous: QaRoundRecord | undefined,
  fixFiles: string[] | null,
): { recheck: QaCriterionRecord[]; carried: QaCriterionRecord[] } {
  const criteria = previous?.criteria ?? [];
  if (fixFiles === null) return { recheck: criteria, carried: [] };
  const changed = new Set(fixFiles.map(baseName));
  const carried = criteria.filter((c) => c.verdict === 'met' && c.files.length > 0 && !c.files.some((f) => changed.has(baseName(f))));
  return { recheck: criteria.filter((c) => !carried.includes(c)), carried };
}

/** Whether a re-review is small enough for the lead to do alone (no QA team). */
export function soloRereview(rounds: QaRoundRecord[], fixFiles: string[] | null): boolean {
  if (fixFiles === null) return false;
  const previous = rounds[rounds.length - 1];
  const { recheck } = carryForward(previous, fixFiles);
  return fixFiles.length <= SMALL_DELTA_FILES || (Boolean(previous?.criteria?.length) && recheck.length <= SMALL_RECHECK);
}

/**
 * The QA lead's system-prompt section for a re-review: every earlier pass's
 * findings, what the fix changed, which criteria carry forward, and how to
 * re-review without starting over.
 */
export function rereviewBrief(
  rounds: QaRoundRecord[],
  fixFiles: string[] | null,
  pass: number,
  declinedNotes: string[] = [],
  responses: QaResponse[] = [],
): string {
  const passes = rounds
    .map((r) => {
      let s = `## Pass ${r.pass} (${r.result ?? 'no result'})`;
      s += r.blocking.length ? `\n\nBlocking:\n${r.blocking.map((f) => `- ${f}`).join('\n')}` : '\n\nNo blocking findings.';
      if (r.notes.length) s += `\n\nNotes:\n${r.notes.map((n) => `- ${n}`).join('\n')}`;
      return s;
    })
    .join('\n\n');

  const delta =
    fixFiles === null
      ? 'Unknown: review the whole branch.'
      : fixFiles.length === 0
        ? 'No files changed since the last pass.'
        : fixFiles.map((f) => `- ${f}`).join('\n');

  const previous = rounds[rounds.length - 1];
  const { recheck, carried } = carryForward(previous, fixFiles);
  const carry =
    carried.length > 0
      ? `\n\n## Carried forward from pass ${previous.pass}\n\nMet last pass, and none of the code they named changed in the fix. ` +
        `Don't review them; list each in the checklist as \`[x] <criterion> — carried forward from pass ${previous.pass}\`.\n\n` +
        carried.map((c) => `- ${c.text}`).join('\n') +
        (recheck.length > 0
          ? `\n\n## Re-check\n\n${recheck.map((c) => `- [${c.verdict}] ${c.text}`).join('\n')}`
          : '\n\n## Re-check\n\nNothing beyond the last pass\'s blocking findings and notes.')
      : '';

  const declined =
    declinedNotes.length > 0
      ? '\n\n## Notes the human chose not to fix\n\nDon\'t raise these again, and don\'t count them as skipped in rule 6:\n\n' +
        declinedNotes.map((n) => `- ${n}`).join('\n')
      : '';

  const answers = responses.length > 0 ? coderAnswersSection(responses) : '';
  const solo = soloRereview(rounds, fixFiles);
  return (
    `\n\n# Earlier QA passes on this branch\n\nThis is pass ${pass}. The coding agent has pushed fixes since the last ` +
    `pass.\n\n${passes}\n\n## Files the fix changed\n\n${delta}${carry}${declined}${answers}\n\n## How to re-review\n\n` +
    '1. get_diff shows only what the fix changed (scope "fix", the default); the rest of the branch was reviewed last pass.\n' +
    '2. Check every blocking finding of the last pass is fixed in the code, with a test that would catch it coming back.\n' +
    '3. Read the fix itself in full, every changed line above: a fix is where new bugs come from.\n' +
    '4. Lint and the unit tests passed before this pass started; don\'t run them.\n' +
    '5. A blocking finding must break an acceptance criterion; name which. Anything else is a note, ' +
    "including a note from an earlier pass that wasn't acted on, unless it breaks a criterion.\n" +
    "6. Last pass's notes: check each was acted on or explained in the coding agent's notes to QA. Repeat the ones " +
    'that were neither, as notes.' +
    (solo
      ? '\n\nThe fix is small: review it yourself. assign_qa_team isn\'t available this pass.'
      : '\n\nIf you split it across reviewers, give them only the re-check criteria and the files the fix changed.')
  );
}

/**
 * The coder's answer to each blocker, and how QA has to treat them. A blocker
 * that comes back unchanged teaches the coder nothing, so a kept one must say
 * what is still wrong, and a dispute that holds is withdrawn out loud.
 */
export function coderAnswersSection(responses: QaResponse[]): string {
  const lines = responses
    .sort((a, b) => a.blocker - b.blocker)
    .map((r) => `### Blocking ${r.blocker} (${r.status}): ${r.finding}\n\nCoder: ${r.explanation}\n\nEvidence: ${r.evidence}`)
    .join('\n\n');
  return (
    '\n\n## The coder\'s answers to your blocking findings\n\n' +
    'Read each before the code. Judge the claim on its evidence, then write the outcome in the report body for every one:\n\n' +
    '- fixed: open the file:line or test given. If it holds, the blocker is gone. If not, keep it and say exactly what is still wrong: the input, the expected and actual result, the line, and why the coder\'s change does not cover it.\n' +
    '- disputed: check the line or behaviour the coder cites. If the coder is right, write "Withdrawn: <why>" and do not list it as a blocker or a note. If not, keep it as a blocker that starts "Re: your dispute —" and answers the explanation point by point, with a concrete case that shows it (file:line, or input and result).\n' +
    '- blocked: the coder could not do it. Work out why from its error. If the criterion cannot be met as written, say so plainly and grade it against what is achievable. If another route exists, name it step by step.\n\n' +
    'A blocker that comes back to the coder must carry something the last one did not: a repeat of the same sentence is not feedback.\n\n' +
    lines
  );
}

/** Why a QA fix is built solo without asking the lead, or null to let the lead decide. */
export function qaFixSoloReason(rounds: QaRoundRecord[]): string | null {
  const latest = rounds[rounds.length - 1];
  if (!latest || latest.blocking.length === 0 || latest.blocking.length > SMALL_FIX_BLOCKERS) return null;
  if (latest.blocking.length + latest.notes.length > SMALL_FIX_ITEMS) return null;
  const notes = latest.notes.length ? ` and ${plural(latest.notes.length, 'note')}` : '';
  return `QA's last pass found ${plural(latest.blocking.length, 'blocking finding')}${notes}, too little to split across a team.`;
}

/**
 * Whether the QA report on disk is this pass's. It isn't while a re-review is
 * pending, while the lead's reviewers' findings haven't been written up, or
 * when the last recorded round is an earlier pass's: acting on it then means
 * acting on findings the branch may already have fixed.
 */
export function qaReportIsCurrent(s: {
  qaReportPath: string | null;
  qaRerunPending: boolean;
  qaTeam: { relayed: boolean } | null;
  qaRounds: QaRoundRecord[];
  qaPass: number;
}): boolean {
  if (!s.qaReportPath || s.qaRerunPending) return false;
  if (s.qaTeam && !s.qaTeam.relayed) return false;
  const last = s.qaRounds[s.qaRounds.length - 1];
  return !last || last.pass === s.qaPass;
}
