/**
 * What a finished session teaches. Pure: the QA passes it went through (the
 * same QaRoundRecords qa-loop.ts reads) become facts, the facts become
 * lessons for the agents that work on this app next and suggestions for
 * whoever maintains Riff. The model pass (model.ts) only adds app-specific
 * detail on top; everything here works without one.
 */
import { analyzeQaLoop, findingSimilarity, SAME_FINDING, type BlockerKind, type QaRoundRecord } from '../sessions/qa-loop.js';

export type BlockerCategory =
  | 'missing-test'
  | 'docs-not-updated'
  | 'docs-inconsistent'
  | 'scope-drift'
  | 'incomplete-coverage'
  | 'red-checks'
  | 'logic-bug';

const CATEGORY_RULES: { category: BlockerCategory; re: RegExp }[] = [
  { category: 'red-checks', re: /\b(unit suite|test suite|tests?) (is|are|still) (red|failing)|\bfails?\b[^.]{0,40}\b(lint|tsc|typecheck)|lint (error|fail)|\bsuite is red\b/i },
  { category: 'scope-drift', re: /\brevert\b|\bunrelated\b|out of scope|outside (?:the )?(?:plan|scope|requirements)|not (?:asked|requested) (?:for|by)|behaviou?r change to (?:the )?(?:build|script)/i },
  { category: 'docs-not-updated', re: /docs? to update|\.md\b[^.]{0,60}(?:untouched|not updated|no entry|not listed)/i },
  { category: 'docs-inconsistent', re: /\b(?:MAP|README|CHANGELOG)\.md\b|\.md\b|structural changes/i },
  { category: 'missing-test', re: /\b(?:no|missing|without|lacks?|still missing|absent)\b[^.]{0,60}\b(?:regression )?tests?\b|\btests?\b[^.]{0,40}\b(?:missing|absent|not added|never added)|regression test/i },
  { category: 'incomplete-coverage', re: /\b(?:no|missing|never|doesn'?t|does not|not) (?:\S+ ){0,4}(?:case|definition|handling|handles?|renders?|covers?|implemented|wired|registered|exported|listed)\b|falls? through|is missing from/i },
];

/** The kind of mistake a blocking finding describes, by what it says. First match wins; anything else is a plain logic bug. */
export function categorizeBlocker(text: string): BlockerCategory {
  for (const { category, re } of CATEGORY_RULES) if (re.test(text)) return category;
  return 'logic-bug';
}

export interface RetroFacts {
  passes: number;
  /** Passes that failed, in a row from the first. */
  failedPasses: number;
  firstPassResult: string | null;
  finalResult: string | null;
  /** Blockers over every pass, classified by mistake and by how they came back. */
  blockers: { text: string; pass: number; category: BlockerCategory; kind: BlockerKind | 'first' }[];
  byCategory: Partial<Record<BlockerCategory, number>>;
  byKind: Partial<Record<BlockerKind, number>>;
  /** Passes that failed on docs alone: a mechanical check would have caught them. */
  docsOnlyPasses: number[];
  /** Failing passes whose head is the one the pass before reviewed: the send-back changed nothing. */
  unchangedResends: number[];
  /** Files named by blockers in two or more passes. */
  hotFiles: string[];
  /** Notes QA wrote that were still open at the end. */
  openNotes: string[];
  gateSendBacks: number;
}

export interface RetroInput {
  rounds: QaRoundRecord[];
  /** Files changed between each pass and the one before it, keyed by the later pass. Missing = unknown. */
  fixFilesByPass?: Record<number, string[] | null>;
  gateSendBacks?: number;
}

export function computeFacts(input: RetroInput): RetroFacts {
  const rounds = [...input.rounds].sort((a, b) => a.pass - b.pass);
  const blockers: RetroFacts['blockers'] = [];
  const byKind: RetroFacts['byKind'] = {};
  const docsOnlyPasses: number[] = [];
  const unchangedResends: number[] = [];

  rounds.forEach((round, i) => {
    if (round.result !== 'fail') return;
    const analysis = analyzeQaLoop(rounds.slice(0, i + 1), input.fixFilesByPass?.[round.pass] ?? null);
    for (const text of round.blocking) {
      const classified = analysis?.blockers.find((b) => b.text === text);
      const kind: BlockerKind | 'first' = i === 0 ? 'first' : (classified?.kind ?? 'missed');
      if (kind !== 'first') byKind[kind] = (byKind[kind] ?? 0) + 1;
      blockers.push({ text, pass: round.pass, category: categorizeBlocker(text), kind });
    }
    const here = blockers.filter((b) => b.pass === round.pass);
    if (here.length > 0 && here.every((b) => b.category === 'docs-not-updated')) docsOnlyPasses.push(round.pass);
    const before = rounds[i - 1];
    if (before && before.head && round.head && before.head === round.head) unchangedResends.push(round.pass);
  });

  const byCategory: RetroFacts['byCategory'] = {};
  for (const b of blockers) byCategory[b.category] = (byCategory[b.category] ?? 0) + 1;

  let failedPasses = 0;
  for (const r of rounds) {
    if (r.result !== 'fail') break;
    failedPasses++;
  }

  const fileCount = new Map<string, Set<number>>();
  for (const b of blockers) {
    for (const f of fileNames(b.text)) {
      if (!fileCount.has(f)) fileCount.set(f, new Set());
      fileCount.get(f)!.add(b.pass);
    }
  }
  const hotFiles = [...fileCount].filter(([, passes]) => passes.size >= 2).map(([f]) => f);

  return {
    passes: rounds.length,
    failedPasses,
    firstPassResult: rounds[0]?.result ?? null,
    finalResult: rounds[rounds.length - 1]?.result ?? null,
    blockers,
    byCategory,
    byKind,
    docsOnlyPasses,
    unchangedResends,
    hotFiles,
    openNotes: rounds[rounds.length - 1]?.notes ?? [],
    gateSendBacks: input.gateSendBacks ?? 0,
  };
}

function fileNames(text: string): string[] {
  const m = text.match(/[\w@.\-/]*[\w-]\.(?:tsx?|jsx?|mjs|cjs|md|json|ya?ml|css|html|py|rs|go|sql|sh)\b/gi) ?? [];
  return [...new Set(m.map((p) => p.split('/').pop()!.toLowerCase()))];
}

/** Whether the session is worth a lesson at all: it needed QA more than once, or QA left something it had to bounce. */
export function worthReviewing(facts: RetroFacts): boolean {
  return facts.failedPasses > 0 || facts.gateSendBacks > 0;
}

export type LessonCategory = BlockerCategory | 'process' | 'app';

/** Something to tell the agents that work on this app. Becomes a line in their briefings. */
export interface LessonDraft {
  text: string;
  category: LessonCategory;
  /** Which agents' briefings it goes in; unset = plan, coding and QA. */
  roles?: LessonRole[];
  /** The screen, folder or feature it applies to; null = the whole app. */
  area: string | null;
  source: 'rule' | 'model';
}

/** A change someone should make to Riff itself. Never applied automatically. */
export interface SystemSuggestion {
  /** Stable for rule-made ones, so a repeat across sessions can be counted. Null for model-written. */
  code: string | null;
  title: string;
  detail: string;
}

const RULE_LESSONS: Record<string, string> = {
  'missing-test':
    'Add a test in the same commit as every bug fix and every new behaviour. QA fails a branch whose fix or feature has no test that would catch it coming back.',
  'docs-not-updated':
    'Before you finish, open every doc the requirements list under "Docs to update" (README.md, MAP.md) and update it in the same branch. QA has failed whole passes on a doc that was left alone.',
  'docs-inconsistent':
    'When you move, rename or add a domain or folder, in the same commit give it a complete README.md (Kind, Parent, Interface, Consumers), point every README.md and MAP.md that mentioned the old path at the new one, and run audit_architecture({ regenerate: true }). QA fails a branch whose docs describe paths that no longer exist.',
  'scope-drift':
    'Change only the files the current plan step names. Don\'t edit build scripts, config or unrelated files; if you already did, revert them before finishing. QA treats an unrelated change as a blocker.',
  'incomplete-coverage':
    'When you add a new case (a type, a section, a segment, a route, a variant), find every place that lists or switches on the existing ones and add yours there: dictionaries, key lists, previews, registries, exports. QA finds the one you missed.',
  'red-checks': 'Run the unit tests and lint on the finished branch and read the result before you report done; a red suite sends the branch straight back.',
  'repeated':
    'Every blocking finding QA lists must be fixed, and each fix proven by a test. Re-read the finding against your change before you report: QA re-reviews the same lines and the same finding comes back if it isn\'t gone.',
  'was-note':
    'Act on every QA note, or say with note_for_qa why you didn\'t. A note you skip comes back as a blocker next pass.',
};

const MIN_REPEAT_FOR_LESSON = 1;

/** Lessons the rules can draw without a model. */
export function ruleLessons(facts: RetroFacts): LessonDraft[] {
  const out: LessonDraft[] = [];
  const add = (key: string, category: LessonCategory) => out.push({ text: RULE_LESSONS[key], category, area: null, source: 'rule' });
  for (const c of ['missing-test', 'docs-not-updated', 'docs-inconsistent', 'scope-drift', 'incomplete-coverage', 'red-checks'] as const) {
    if ((facts.byCategory[c] ?? 0) >= MIN_REPEAT_FOR_LESSON) add(c, c);
  }
  if ((facts.byKind.repeated ?? 0) > 0) add('repeated', 'process');
  if ((facts.byKind['was-note'] ?? 0) > 0) add('was-note', 'process');
  return out;
}

/** Suggestions for the system itself, from how the passes went rather than what they found. */
export function ruleSuggestions(facts: RetroFacts): SystemSuggestion[] {
  const out: SystemSuggestion[] = [];
  if (facts.docsOnlyPasses.length > 0) {
    out.push({
      code: 'docs-check-before-qa',
      title: 'Check the docs mechanically before QA',
      detail:
        `QA spent ${facts.docsOnlyPasses.length === 1 ? 'a pass' : `${facts.docsOnlyPasses.length} passes`} (${facts.docsOnlyPasses.join(', ')}) failing only on docs ` +
        'the requirements said to update. The pre-QA gate could compare the requirements\' "Docs to update" list with the files the branch touched and send the coder back itself, for the cost of a git diff instead of a QA round.',
    });
  }
  if (facts.unchangedResends.length > 0) {
    out.push({
      code: 'send-back-changed-nothing',
      title: 'A send-back produced no new commits',
      detail:
        `Pass ${facts.unchangedResends.join(', ')} reviewed the same commit as the pass before it, so the coding agent was sent back and changed nothing. ` +
        'Bridget could refuse to start a re-review while the branch head is unchanged and put the QA findings in front of the coder again (or stop for the human) instead of paying for a pass that can only repeat itself.',
    });
  }
  if (facts.hotFiles.length > 0 && facts.failedPasses >= 3) {
    out.push({
      code: 'same-file-blocked-repeatedly',
      title: 'One area failed QA again and again',
      detail:
        `${facts.hotFiles.slice(0, 4).join(', ')} were named by blockers in more than one pass across ${facts.failedPasses} failing passes. ` +
        'When the same file blocks twice, the plan step for it may be too big or unclear: Bridget could ask the plan agent to split that step before a third fix attempt.',
    });
  }
  if (facts.gateSendBacks >= 2) {
    out.push({
      code: 'gate-sent-back-repeatedly',
      title: 'Lint and tests failed before QA more than once',
      detail: `The pre-QA gate sent coding back ${facts.gateSendBacks} times. The coding prompt could ask the coder to run the checks on the finished branch before reporting done.`,
    });
  }
  if (facts.failedPasses >= 3) {
    out.push({
      code: 'many-failed-passes',
      title: `QA failed ${facts.failedPasses} passes in a row`,
      detail:
        `This branch cost ${facts.passes} QA passes. Most of the findings were ` +
        `${dominant(facts) ?? 'varied'}. Compare with the lessons Riff recorded for this app to see whether the briefings are catching it.`,
    });
  }
  return out;
}

function dominant(facts: RetroFacts): string | null {
  const top = Object.entries(facts.byCategory).sort((a, b) => b[1] - a[1])[0];
  return top ? `${top[0].replace(/-/g, ' ')} (${top[1]} of ${facts.blockers.length})` : null;
}

export interface StoredLesson {
  id: string;
  text: string;
  category: LessonCategory;
  roles?: LessonRole[];
  area: string | null;
  source: 'rule' | 'model';
  /** retired = Bridget took it out of the briefings because it wasn't working; dismissed = the human did. */
  status: 'active' | 'dismissed' | 'retired';
  retiredReason?: string;
  /** Sessions that started while it was in the briefings, and the ones among them where the same mistake came back. */
  exposedSessionIds: string[];
  recurredSessionIds: string[];
  /** How many sessions produced it. A lesson that keeps coming back sorts first in the briefing. */
  seen: number;
  sessionIds: string[];
  firstAt: string;
  lastAt: string;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Folds a session's drafts into an app's lessons: a draft like an existing
 * lesson (even a dismissed one, which stays dismissed) counts as another
 * sighting from this session instead of a second line. `matched` is the ids
 * of the existing lessons the drafts repeated.
 */
export function mergeLessonsDetailed(
  existing: StoredLesson[],
  drafts: LessonDraft[],
  sessionId: string,
  now: string,
  newId: () => string,
  cap = 60,
): { lessons: StoredLesson[]; matched: Set<string> } {
  const lessons = existing.map((l) => ({ ...l, sessionIds: [...l.sessionIds] }));
  const matched = new Set<string>();
  for (const draft of drafts) {
    const text = draft.text.trim();
    if (!text) continue;
    const match = lessons.find((l) => norm(l.text) === norm(text) || findingSimilarity(l.text, text) >= SAME_FINDING);
    if (match) {
      matched.add(match.id);
      if (!match.sessionIds.includes(sessionId)) {
        match.sessionIds.push(sessionId);
        match.seen = match.sessionIds.length;
      }
      match.lastAt = now;
      continue;
    }
    lessons.push({
      id: newId(),
      text,
      category: draft.category,
      ...(draft.roles ? { roles: draft.roles } : {}),
      area: draft.area,
      source: draft.source,
      status: 'active',
      exposedSessionIds: [],
      recurredSessionIds: [],
      seen: 1,
      sessionIds: [sessionId],
      firstAt: now,
      lastAt: now,
    });
  }
  // Over the cap, the least-seen oldest lessons go first, dismissed and retired ones before active.
  while (lessons.length > cap) {
    const i = lessons
      .map((l, idx) => ({ l, idx }))
      .sort((a, b) => Number(b.l.status !== 'active') - Number(a.l.status !== 'active') || a.l.seen - b.l.seen || a.l.lastAt.localeCompare(b.l.lastAt))[0].idx;
    lessons.splice(i, 1);
  }
  return { lessons, matched };
}

export function mergeLessons(existing: StoredLesson[], drafts: LessonDraft[], sessionId: string, now: string, newId: () => string, cap = 60): StoredLesson[] {
  return mergeLessonsDetailed(existing, drafts, sessionId, now, newId, cap).lessons;
}

/** Sessions of evidence before a lesson is judged. */
export const MIN_EXPOSED = 3;
const NOT_WORKING_RATE = 0.6;
const WORKING_RATE = 0.2;

export type LessonVerdict = 'unproven' | 'working' | 'mixed' | 'not-working';

/** Whether a lesson in the briefings is paying off: how often the mistake it names came back in sessions that had it. */
export function lessonVerdict(l: Pick<StoredLesson, 'exposedSessionIds' | 'recurredSessionIds'>): LessonVerdict {
  const exposed = l.exposedSessionIds.length;
  if (exposed < MIN_EXPOSED) return 'unproven';
  const rate = l.recurredSessionIds.length / exposed;
  if (rate >= NOT_WORKING_RATE) return 'not-working';
  return rate <= WORKING_RATE ? 'working' : 'mixed';
}

/**
 * Scores the lessons that were in the briefings when a session started
 * (created before it, still active): each such lesson was exposed, and
 * recurred if this session's drafts repeated it. A clean session counts as
 * exposure with no recurrence, which is how a lesson earns "working".
 * Lessons that aren't working are retired and returned so Bridget can say so.
 */
export function scoreLessons(
  lessons: StoredLesson[],
  session: { id: string; startedAt: string },
  matched: Set<string>,
): { lessons: StoredLesson[]; retired: StoredLesson[] } {
  const retired: StoredLesson[] = [];
  const out = lessons.map((l) => {
    if (l.status !== 'active' || l.firstAt > session.startedAt || l.exposedSessionIds.includes(session.id)) return l;
    const next: StoredLesson = {
      ...l,
      exposedSessionIds: [...l.exposedSessionIds, session.id],
      recurredSessionIds: matched.has(l.id) ? [...l.recurredSessionIds, session.id] : l.recurredSessionIds,
    };
    if (lessonVerdict(next) === 'not-working') {
      const reason = `the same mistake came back in ${next.recurredSessionIds.length} of the ${next.exposedSessionIds.length} sessions that had it in their briefing`;
      const gone: StoredLesson = { ...next, status: 'retired', retiredReason: reason };
      retired.push(gone);
      return gone;
    }
    return next;
  });
  return { lessons: out, retired };
}

/** A lesson that stopped working is a mistake a prompt line can't prevent: it needs a check in the pipeline. */
export function retiredLessonSuggestion(l: StoredLesson): SystemSuggestion {
  return {
    code: `lesson-ignored:${l.id}`,
    title: 'A lesson in the briefings isn\'t preventing its mistake',
    detail:
      `"${l.text}" was in the plan/coding/QA briefings and ${l.retiredReason}, so Bridget took it out. Telling the agents isn't enough here: ` +
      'this needs a mechanical check (a pre-QA gate rule, a tool refusal) or a change to the step it keeps getting wrong.',
  };
}

export const MAX_BRIEFING_LESSONS = 8;
const MAX_BRIEFING_CHARS = 2400;

/** The active lessons that make the briefing: the ones seen most first, then the newest. */
export function pickBriefingLessons(lessons: StoredLesson[], role?: LessonRole): StoredLesson[] {
  const picked: StoredLesson[] = [];
  let chars = 0;
  const ranked = lessons.filter((l) => l.status === 'active' && (!role || !l.roles || l.roles.includes(role))).sort((a, b) => b.seen - a.seen || b.lastAt.localeCompare(a.lastAt));
  for (const l of ranked) {
    if (picked.length >= MAX_BRIEFING_LESSONS || chars + l.text.length > MAX_BRIEFING_CHARS) break;
    picked.push(l);
    chars += l.text.length;
  }
  return picked;
}

export type LessonRole = 'plan' | 'coding' | 'qa';

const LESSON_ROLE_NOTE: Record<LessonRole, string> = {
  plan: 'Write plan steps that cover these: name the docs, registries and tests each step has to touch.',
  coding: 'Check your finished work against each line before you report a step done or answer a QA finding.',
  qa: 'Check the branch against each line first: these are the mistakes earlier branches of this app were failed for, so look for them before anything else, and grade them like any other criterion.',
};

/** The briefing section for one role, or '' when nothing has been learned. */
export function lessonsBriefing(lessons: StoredLesson[], role: LessonRole): string {
  const picked = pickBriefingLessons(lessons, role);
  if (picked.length === 0) return '';
  const lines = picked.map((l) => `- ${l.area ? `(${l.area}) ` : ''}${l.text}`).join('\n');
  return (
    '\n\n# Lessons from this app\'s earlier sessions\n\n' +
    'Branches of this app were sent back from QA for the following. They come from reviewing what actually failed, so treat them as ' +
    `requirements.\n\n${lines}\n\n${LESSON_ROLE_NOTE[role]}`
  );
}

export function lessonsFingerprint(lessons: StoredLesson[]): string {
  const picked = pickBriefingLessons(lessons);
  return picked.length === 0 ? 'none' : picked.map((l) => `${l.id}:${l.text.length}`).join(',');
}

/** One line for the QA chat when the retrospective is done. */
export function retroChatSummary(facts: RetroFacts, added: number, suggestions: number, retired = 0, muted = 0): string {
  const top = dominant(facts);
  const parts = [`Retrospective: QA took ${facts.passes} pass${facts.passes === 1 ? '' : 'es'}${facts.failedPasses ? ` (${facts.failedPasses} failed)` : ''}.`];
  if (top) parts.push(`Most blockers were ${top}.`);
  if (added > 0) parts.push(`${added} new lesson${added === 1 ? '' : 's'} added to the briefings for this app's next sessions.`);
  else if (facts.failedPasses > 0) parts.push('Nothing new to add: the lessons already on file cover it.');
  if (suggestions > 0) parts.push(`${suggestions} suggestion${suggestions === 1 ? '' : 's'} for improving Riff itself are on the QA tab.`);
  if (retired > 0) parts.push(`${retired} earlier lesson${retired === 1 ? '' : 's'} didn't stop the mistake it names, so I took ${retired === 1 ? 'it' : 'them'} out of the briefings.`);
  if (muted > 0) parts.push(`I've stopped raising ${muted} suggestion${muted === 1 ? '' : 's'} nobody acted on.`);
  return parts.join(' ');
}
