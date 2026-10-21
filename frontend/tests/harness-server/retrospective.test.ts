import { beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  categorizeBlocker,
  computeFacts,
  lessonsBriefing,
  lessonVerdict,
  mergeLessons,
  mergeLessonsDetailed,
  scoreLessons,
  pickBriefingLessons,
  ruleLessons,
  ruleSuggestions,
  worthReviewing,
  type StoredLesson,
} from '../../../harness-server/backend/src/retrospective/core';
import { suggestionVerdict, trackSuggestions, setSuggestionStatus, type TrackedSuggestion } from '../../../harness-server/backend/src/retrospective/suggestion-tracker';
import { parseModelRetro } from '../../../harness-server/backend/src/retrospective/model';
import type { QaRoundRecord } from '../../../harness-server/backend/src/sessions/qa-loop';

const dir = mkdtempSync(path.join(tmpdir(), 'retro-'));
process.env.HARNESS_LESSONS_PATH = path.join(dir, 'lessons.json');
process.env.HARNESS_RETRO_DIR = path.join(dir, 'retros');

let store: typeof import('../../../harness-server/backend/src/retrospective/store');
beforeAll(async () => {
  store = await import('../../../harness-server/backend/src/retrospective/store');
});

// Blockers as QA wrote them on real sessions: Cleanup (docs only, no commits between passes),
// EDI 856 (a missed case, then a script the branch had no business touching) and Script breakdown.
const DOCS =
  'client/src/storyboards-ui/StoryboardPanel/DOMAIN.md is listed in the requirements\' "Docs to update" but is untouched by the branch — add a Rules entry';
const DOCS_AGAIN =
  'client/src/storyboards-ui/StoryboardPanel/DOMAIN.md is listed in the requirements\' "Docs to update" but is still untouched by the branch (no commits since pass 1) — add a Rules entry';
const MISSING_CASE =
  "client/src/features/edi-viewer/DataSections.tsx sectionPreview (~line 33-65): no 'shipments' case, so the Shipments panel's collapsed preview falls through to the default";
const SCRIPT =
  'scripts/generate-paths.js — revert to its base-branch state: the branch changes `require(\'dotenv\').config()` to a fixed path (a behaviour change to the build script)';
const NO_TEST =
  "src/scripts/BreakdownPanel/BreakdownPanel.test.tsx — the regression test pass 2 asked for is still missing: 'writes a successful autosave into the query cache'";
const LOGIC =
  'client/src/features/edi-viewer/DataSections.tsx:61 — the Totals panel\'s 856 fallback reads `find(...,\'CTT\')?.elements[1]`, which is CTT02 (hash total), not CTT01';

const round = (pass: number, result: string, blocking: string[], head: string | null, notes: string[] = []): QaRoundRecord => ({
  pass,
  at: `2026-10-1${pass}T00:00:00Z`,
  result,
  blocking,
  notes,
  head,
});

describe('categorizeBlocker', () => {
  test('sorts real findings by the mistake they describe', () => {
    expect(categorizeBlocker(DOCS)).toBe('docs-not-updated');
    expect(categorizeBlocker(MISSING_CASE)).toBe('incomplete-coverage');
    expect(categorizeBlocker(SCRIPT)).toBe('scope-drift');
    expect(categorizeBlocker(NO_TEST)).toBe('missing-test');
    expect(categorizeBlocker(LOGIC)).toBe('logic-bug');
    expect(categorizeBlocker("the unit suite is red: ScriptsPage.test.tsx fails")).toBe('red-checks');
  });
});

describe('computeFacts', () => {
  test('a docs-only loop with no commits between passes', () => {
    const facts = computeFacts({
      rounds: [
        round(1, 'fail', [DOCS], 'aaa'),
        round(2, 'fail', [DOCS_AGAIN], 'aaa'),
        round(3, 'fail', [DOCS_AGAIN], 'aaa'),
        round(4, 'pass', [], 'bbb'),
      ],
    });
    expect(facts.passes).toBe(4);
    expect(facts.failedPasses).toBe(3);
    expect(facts.docsOnlyPasses).toEqual([1, 2, 3]);
    expect(facts.unchangedResends).toEqual([2, 3]);
    expect(facts.byKind.repeated).toBe(2);
    const codes = ruleSuggestions(facts).map((s) => s.code);
    expect(codes).toContain('docs-check-before-qa');
    expect(codes).toContain('send-back-changed-nothing');
    expect(codes).toContain('many-failed-passes');
  });

  test('a branch that passes first time teaches nothing', () => {
    const facts = computeFacts({ rounds: [round(1, 'pass-with-notes', [], 'aaa', ['rename x'])] });
    expect(worthReviewing(facts)).toBe(false);
    expect(ruleLessons(facts)).toHaveLength(0);
    expect(ruleSuggestions(facts)).toHaveLength(0);
  });

  test('categories, first-seen kinds and hot files over a mixed history', () => {
    const facts = computeFacts({
      rounds: [
        round(1, 'fail', [MISSING_CASE, NO_TEST], 'a1'),
        round(2, 'fail', [LOGIC, SCRIPT], 'a2'),
        round(3, 'fail', [LOGIC], 'a3'),
        round(4, 'pass', [], 'a4'),
      ],
      fixFilesByPass: { 2: ['client/src/features/edi-viewer/DataSections.tsx'], 3: ['x.ts'] },
    });
    expect(facts.byCategory['incomplete-coverage']).toBe(1);
    expect(facts.byCategory['missing-test']).toBe(1);
    expect(facts.byCategory['scope-drift']).toBe(1);
    expect(facts.byCategory['logic-bug']).toBe(2);
    expect(facts.blockers.filter((b) => b.pass === 1).every((b) => b.kind === 'first')).toBe(true);
    expect(facts.blockers.find((b) => b.pass === 2 && b.text === LOGIC)!.kind).toBe('in-fix');
    expect(facts.blockers.find((b) => b.pass === 3)!.kind).toBe('repeated');
    expect(facts.hotFiles).toContain('datasections.tsx');
    const lessons = ruleLessons(facts).map((l) => l.category);
    expect(lessons).toEqual(expect.arrayContaining(['missing-test', 'scope-drift', 'incomplete-coverage', 'process']));
  });
});

describe('lessons', () => {
  const now = '2026-10-20T00:00:00Z';
  let n = 0;
  const id = () => `id${++n}`;

  test('the same lesson from another session is one lesson seen twice; a dismissed one stays dismissed', () => {
    const draft = { text: 'Update every doc the requirements list under "Docs to update" in the same branch.', category: 'docs-not-updated' as const, area: null, source: 'rule' as const };
    const first = mergeLessons([], [draft], 's1', now, id);
    expect(first).toHaveLength(1);
    const again = mergeLessons(first, [{ ...draft, text: draft.text.toUpperCase() }], 's2', now, id);
    expect(again).toHaveLength(1);
    expect(again[0].seen).toBe(2);
    const sameSession = mergeLessons(again, [draft], 's2', now, id);
    expect(sameSession[0].seen).toBe(2);
    const dismissed = again.map((l) => ({ ...l, status: 'dismissed' as const }));
    const after = mergeLessons(dismissed, [draft], 's3', now, id);
    expect(after).toHaveLength(1);
    expect(after[0].status).toBe('dismissed');
  });

  const stored = (text: string, seen: number, status: StoredLesson['status'] = 'active'): StoredLesson => ({
    id: text.slice(0, 4),
    text,
    category: 'app',
    area: null,
    source: 'model',
    status,
    exposedSessionIds: [],
    recurredSessionIds: [],
    seen,
    sessionIds: [],
    firstAt: now,
    lastAt: now,
  });

  test('the briefing holds the most-seen active lessons, within its limits, per role', () => {
    const many = Array.from({ length: 12 }, (_, i) => stored(`lesson number ${i} about a distinct thing ${'x'.repeat(i)}`, i));
    many.push(stored('dismissed lesson that must not appear', 99, 'dismissed'));
    const picked = pickBriefingLessons(many);
    expect(picked).toHaveLength(8);
    expect(picked[0].seen).toBe(11);
    expect(picked.some((l) => l.status === 'dismissed')).toBe(false);
    expect(lessonsBriefing(many, 'qa')).toContain('Check the branch against each line first');
    expect(lessonsBriefing(many, 'plan')).toContain('Write plan steps');
    expect(lessonsBriefing([], 'coding')).toBe('');
    expect(lessonsBriefing([stored('only dismissed', 1, 'dismissed')], 'coding')).toBe('');
  });
});

describe('lesson feedback', () => {
  const draft = { text: 'Update every doc listed under "Docs to update" in the same branch as the code.', category: 'docs-not-updated' as const, area: null, source: 'rule' as const };
  let n = 0;
  const id = () => `L${++n}`;
  const base = mergeLessons([], [draft], 's0', '2026-10-01T00:00:00Z', id);

  // One session per day after the lesson was learned; `again` = the mistake came back.
  const run = (lessons: typeof base, i: number, again: boolean) => {
    const sid = `s${i}`;
    const { lessons: merged, matched } = mergeLessonsDetailed(lessons, again ? [draft] : [], sid, '2026-10-10T00:00:00Z', id);
    return scoreLessons(merged, { id: sid, startedAt: `2026-10-0${i + 1}T00:00:00Z` }, matched);
  };

  test('a session started before the lesson existed is no evidence', () => {
    const r = scoreLessons(base, { id: 'old', startedAt: '2026-09-30T00:00:00Z' }, new Set(base.map((l) => l.id)));
    expect(r.lessons[0].exposedSessionIds).toHaveLength(0);
  });

  test('a lesson whose mistake keeps coming back is retired after three sessions', () => {
    let lessons = base;
    let retired = 0;
    for (const i of [1, 2, 3]) {
      const r = run(lessons, i, true);
      lessons = r.lessons;
      retired += r.retired.length;
      if (i < 3) expect(lessons[0].status).toBe('active');
    }
    expect(retired).toBe(1);
    expect(lessons[0].status).toBe('retired');
    expect(lessons[0].retiredReason).toContain('3 of the 3');
    expect(pickBriefingLessons(lessons)).toHaveLength(0);
    // seen again later, it stays retired and is not re-added
    const later = mergeLessons(lessons, [draft], 's9', '2026-10-20T00:00:00Z', id);
    expect(later).toHaveLength(1);
    expect(later[0].status).toBe('retired');
  });

  test('clean sessions earn "working" and the lesson stays', () => {
    let lessons = base;
    for (const i of [1, 2, 3, 4]) lessons = run(lessons, i, false).lessons;
    expect(lessonVerdict(lessons[0])).toBe('working');
    expect(lessons[0].status).toBe('active');
  });

  test('one recurrence in three is mixed, not retired', () => {
    let lessons = run(base, 1, true).lessons;
    lessons = run(lessons, 2, false).lessons;
    lessons = run(lessons, 3, false).lessons;
    expect(lessonVerdict(lessons[0])).toBe('mixed');
    expect(lessons[0].status).toBe('active');
  });

  test('a lesson is only in the briefings of the roles it names', () => {
    const l = { ...base[0], roles: ['qa' as const] };
    expect(lessonsBriefing([l], 'qa')).toContain('Docs to update');
    expect(lessonsBriefing([l], 'coding')).toBe('');
  });
});

describe('suggestion tracking', () => {
  const s = { code: 'docs-check-before-qa', title: 'Check the docs mechanically before QA', detail: 'QA failed passes on docs only.' };
  const at = (i: number) => ({ id: `s${i}`, startedAt: `2026-10-${String(i).padStart(2, '0')}T12:00:00Z` });
  const now = '2026-10-30T00:00:00Z';

  test('an ignored suggestion is muted on its fourth sighting and then not shown', () => {
    let tracked: TrackedSuggestion[] = [];
    const shown: number[] = [];
    for (const i of [1, 2, 3, 4, 5]) {
      const r = trackSuggestions(tracked, [s], at(i), now);
      tracked = r.tracked;
      shown.push(r.visible.length);
      if (i === 4) expect(r.newlyMuted).toHaveLength(1);
    }
    expect(shown).toEqual([1, 1, 1, 0, 0]);
    expect(tracked[0].status).toBe('muted');
    expect(tracked[0].mutedReason).toContain('4 sessions');
  });

  test('a dismissed suggestion is never shown again', () => {
    let tracked = trackSuggestions([], [s], at(1), now).tracked;
    tracked = setSuggestionStatus(tracked, tracked[0].key, 'dismissed', now);
    expect(trackSuggestions(tracked, [s], at(2), now).visible).toHaveLength(0);
  });

  test('a suggestion marked done is judged by whether it keeps coming back', () => {
    let tracked = trackSuggestions([], [s], at(1), '2026-10-02T00:00:00Z').tracked;
    tracked = setSuggestionStatus(tracked, tracked[0].key, 'done', '2026-10-02T00:00:00Z');
    for (const i of [3, 4, 5]) tracked = trackSuggestions(tracked, [], at(i), now).tracked;
    expect(suggestionVerdict(tracked[0])).toBe('effective');

    let bad = trackSuggestions([], [s], at(1), '2026-10-02T00:00:00Z').tracked;
    bad = setSuggestionStatus(bad, bad[0].key, 'done', '2026-10-02T00:00:00Z');
    for (const i of [3, 4, 5]) {
      const r = trackSuggestions(bad, [s], at(i), now);
      bad = r.tracked;
      expect(r.visible).toHaveLength(1);
    }
    expect(suggestionVerdict(bad[0])).toBe('not-effective');
  });

  test('model-written suggestions match across sessions by wording', () => {
    const m = { code: null, title: 'Refuse a re-review on an unchanged branch', detail: 'Pass 3 reviewed the commit pass 2 reviewed, so QA repeated itself.' };
    const a = trackSuggestions([], [m], at(1), now).tracked;
    const b = trackSuggestions(a, [{ ...m, title: 'Refuse a re-review on an unchanged branch!' }], at(2), now).tracked;
    expect(b).toHaveLength(1);
    expect(b[0].raisedIn).toHaveLength(2);
  });
});

describe('model reply', () => {
  test('a suggestion aimed at an agent becomes a lesson in its briefing, a pipeline one stays a suggestion', () => {
    const r = parseModelRetro(
      JSON.stringify({
        summary: 's',
        lessons: [],
        suggestions: [
          { title: 'QA should list the fixed files', detail: 'Pass 3 repeated work.', target: 'qa', instruction: 'Open your report with the files the fix changed.' },
          { title: 'Gate on docs', detail: 'Compare Docs to update with the diff before QA.', target: 'pipeline' },
        ],
      }),
    );
    expect(r!.suggestions).toHaveLength(1);
    expect(r!.suggestions[0].title).toBe('Gate on docs');
    expect(r!.lessons).toHaveLength(1);
    expect(r!.lessons[0].roles).toEqual(['qa']);
    expect(r!.lessons[0].text).toContain('Open your report');
  });

  test('parses a well-formed reply and bounds it', () => {
    const r = parseModelRetro(
      'Here: {"summary":"Docs were skipped.","lessons":[{"text":"When adding a transaction type, update the dictionary, key list and previews.","area":"edi-viewer"}],"suggestions":[{"title":"Gate on docs","detail":"Compare the Docs to update list with the diff before QA."}]}',
    );
    expect(r!.lessons[0].area).toBe('edi-viewer');
    expect(r!.lessons[0].source).toBe('model');
    expect(r!.suggestions[0].code).toBeNull();
  });

  test('rejects garbage and over-long lessons', () => {
    expect(parseModelRetro('nope')).toBeNull();
    expect(parseModelRetro(JSON.stringify({ summary: '', lessons: [{ text: 'x'.repeat(500) }], suggestions: [] }))).toBeNull();
  });
});

describe('store', () => {
  test('adds, dismisses and deletes lessons per app; keeps retrospectives', () => {
    const draft = { text: 'Add a test with every fix, in the same commit as the fix itself.', category: 'missing-test' as const, area: null, source: 'rule' as const };
    const a = store.addLessons('app1', { id: 's1', startedAt: '2026-10-01T00:00:00Z' }, [draft]);
    expect(a.added).toBe(1);
    expect(store.addLessons('app1', { id: 's2', startedAt: '2026-10-02T00:00:00Z' }, [draft]).added).toBe(0);
    expect(store.listLessons('app2')).toHaveLength(0);
    const id = a.lessons[0].id;
    expect(store.setLessonStatus('app1', id, 'dismissed')[0].status).toBe('dismissed');
    expect(store.deleteLesson('app1', id)).toHaveLength(0);

    store.writeRetrospective({
      sessionId: 's1',
      appId: 'app1',
      title: 't',
      at: '2026-10-20T00:00:00Z',
      facts: computeFacts({ rounds: [] }),
      summary: '',
      lessonsAdded: 0,
      lessons: [],
      suggestions: [],
      modelUsed: false,
      lessonsRetired: [],
      suggestionsMuted: [],
    });
    expect(store.listRetrospectives('app1')).toHaveLength(1);
    expect(store.listRetrospectives('app2')).toHaveLength(0);
    expect(store.readRetrospective('missing')).toBeNull();
  });
});

describe('lessons saved by an earlier version', () => {
  test('are read with empty evidence instead of crashing', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      process.env.HARNESS_LESSONS_PATH!,
      JSON.stringify({ old: [{ id: 'x', text: 'An old lesson from before feedback tracking.', category: 'app', area: null, source: 'model', status: 'active', seen: 1, firstAt: '2026-10-01T00:00:00Z', lastAt: '2026-10-01T00:00:00Z' }] }),
    );
    const l = store.listLessons('old')[0];
    expect(l.exposedSessionIds).toEqual([]);
    expect(lessonVerdict(l)).toBe('unproven');
    expect(store.addLessons('old', { id: 's1', startedAt: '2026-10-10T00:00:00Z' }, []).lessons[0].exposedSessionIds).toEqual(['s1']);
  });
});
