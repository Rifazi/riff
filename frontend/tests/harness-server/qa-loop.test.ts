import { describe, expect, test } from 'bun:test';

import {
  analyzeQaLoop,
  carryForward,
  findingFiles,
  findingSimilarity,
  loopBrief,
  qaFixSoloReason,
  qaReportIsCurrent,
  rereviewBrief,
  SAME_FINDING,
  soloRereview,
  type QaCriterionRecord,
  type QaRoundRecord,
} from '../../../harness-server/backend/src/sessions/qa-loop';
import { compactQaFindings, reportCriteria } from '../../../harness-server/backend/src/sessions/qa-findings';

// Findings as QA wrote them in session 7bdd0d9e (EDI Viewer 856), which went
// back to coding four times.
const HL_FORWARD =
  'client/src/features/edi-viewer/lib/parser856.ts:220-230 + validator.ts:598-607 — an HL02 that references an HL01 ' +
  'appearing *later* in the same transaction is resolved as a valid parent, so the referential check never fires; ' +
  'resolve parents only against ids already seen, and add a validator test for a forward HL02 reference.';
const SHIPMENTS_NOTE =
  "client/src/features/edi-viewer/DataSections.tsx sectionPreview: the 'shipments' panel falls through to the default " +
  '"N entries" preview, counting the first Shipment\'s own segments rather than shipments.';
const SHIPMENTS_BLOCKER =
  "client/src/features/edi-viewer/DataSections.tsx sectionPreview (~line 33-65): no 'shipments' case, so the Shipments " +
  'panel\'s collapsed preview falls through to the default "N entries" — add a \'shipments\' case previewing the ' +
  'shipment count. Previous QA filed this; unfixed.';
const TOTALS_BLOCKER =
  "client/src/features/edi-viewer/DataSections.tsx sectionPreview 'totals' case (~line 58): reads AMT only, so an " +
  "856's Totals panel (CTT only) renders an empty preview — fall back to CTT01 (line-item count) when AMT is absent.";
const CTT_BLOCKER =
  "client/src/features/edi-viewer/DataSections.tsx:61 — the Totals panel's 856 fallback reads " +
  "`find(...,'CTT')?.elements[1]`, which is CTT02 (hash total), not CTT01; elements are 0-indexed (validator.ts:578 " +
  'uses `ctt.elements[0]` for CTT01), so a typical 856 with only CTT01 shows an empty Totals preview. Change to `elements[0]`.';
const OTHER_KEYS =
  "client/src/features/edi-viewer/lib/sections.ts (HL_KEYS_856, ~line 418): `other` is missing from the key list, so " +
  "the unrecognized in-loop segments parser856.ts retains on `node.other` are dropped before rendering — add 'other'.";

const round = (pass: number, result: string, blocking: string[], notes: string[] = [], head: string | null = null): QaRoundRecord => ({
  pass,
  at: `2026-10-14T1${pass}:00:00.000Z`,
  result,
  blocking,
  notes,
  head,
});

describe('matching findings across passes', () => {
  test('the file names a finding mentions', () => {
    expect(findingFiles(CTT_BLOCKER)).toEqual(['datasections.tsx', 'validator.ts']);
    expect(findingFiles('e.g. lint fails')).toEqual([]);
  });

  test('a fix of the same thing in the same file is the same finding', () => {
    expect(findingSimilarity(CTT_BLOCKER, TOTALS_BLOCKER)).toBeGreaterThanOrEqual(SAME_FINDING);
    expect(findingSimilarity(SHIPMENTS_BLOCKER, SHIPMENTS_NOTE)).toBeGreaterThanOrEqual(SAME_FINDING);
  });

  test('findings about different files are different', () => {
    expect(findingSimilarity(CTT_BLOCKER, HL_FORWARD)).toBe(0);
    expect(findingSimilarity(OTHER_KEYS, TOTALS_BLOCKER)).toBe(0);
  });
});

describe('analyzeQaLoop', () => {
  test('nothing to say about a pass that didn’t fail', () => {
    expect(analyzeQaLoop([round(1, 'pass-with-notes', [], ['x'])], null)).toBeNull();
    expect(analyzeQaLoop([], null)).toBeNull();
  });

  test('a first failing pass is not a loop', () => {
    const loop = analyzeQaLoop([round(1, 'fail', [HL_FORWARD])], null)!;
    expect(loop.looping).toBe(false);
    expect(loop.blockers.map((b) => b.kind)).toEqual(['missed']);
  });

  test('a skipped note that comes back as a blocker', () => {
    const loop = analyzeQaLoop(
      [round(1, 'fail', [HL_FORWARD], [SHIPMENTS_NOTE]), round(2, 'fail', [OTHER_KEYS, SHIPMENTS_BLOCKER, TOTALS_BLOCKER])],
      ['client/src/features/edi-viewer/lib/parser856.ts'],
    )!;
    expect(loop.blockers.map((b) => b.kind)).toEqual(['missed', 'was-note', 'missed']);
    expect(loop.looping).toBe(true);
    expect(loop.reasons.join(' ')).toContain('started as a note');
  });

  test('a fix that broke the line it fixed comes back as repeated', () => {
    const loop = analyzeQaLoop(
      [round(1, 'fail', [HL_FORWARD]), round(2, 'fail', [TOTALS_BLOCKER]), round(3, 'fail', [CTT_BLOCKER])],
      ['client/src/features/edi-viewer/DataSections.tsx'],
    )!;
    expect(loop.blockers).toEqual([{ text: CTT_BLOCKER, kind: 'repeated', earlierPass: 2 }]);
    expect(loop.failedInARow).toBe(3);
    expect(loop.looping).toBe(true);
    expect(loop.smallFix).toBe(true);
  });

  test('a new blocker in a file the fix changed is in the fix', () => {
    const loop = analyzeQaLoop([round(1, 'fail', [HL_FORWARD]), round(2, 'fail', [OTHER_KEYS])], ['client/src/x/sections.ts'])!;
    expect(loop.blockers[0].kind).toBe('in-fix');
    expect(loop.looping).toBe(true);
  });

  test('two failing passes with only new findings elsewhere are not yet a loop', () => {
    const loop = analyzeQaLoop([round(1, 'fail', [HL_FORWARD]), round(2, 'fail', [OTHER_KEYS])], ['docs/a.md'])!;
    expect(loop.blockers[0].kind).toBe('missed');
    expect(loop.looping).toBe(false);
  });

  test('a pass in between resets the run of failures', () => {
    const loop = analyzeQaLoop(
      [round(1, 'fail', [HL_FORWARD]), round(2, 'pass-with-notes', []), round(3, 'fail', [OTHER_KEYS])],
      null,
    )!;
    expect(loop.failedInARow).toBe(1);
  });
});

describe('what the agents get', () => {
  const rounds = [round(1, 'fail', [HL_FORWARD], [SHIPMENTS_NOTE]), round(2, 'fail', [TOTALS_BLOCKER])];

  test('the re-review brief lists every pass, what the fix changed and how to re-review', () => {
    const brief = rereviewBrief(rounds, ['client/src/features/edi-viewer/DataSections.tsx'], 3);
    expect(brief).toContain('This is pass 3.');
    expect(brief).toContain('## Pass 1 (fail)');
    expect(brief).toContain(SHIPMENTS_NOTE);
    expect(brief).toContain('- client/src/features/edi-viewer/DataSections.tsx');
    expect(brief).toContain("assign_qa_team isn't available this pass");
  });

  test('a large or unknown fix is not called small', () => {
    expect(rereviewBrief(rounds, null, 3)).toContain('Unknown: review the whole branch.');
    expect(rereviewBrief(rounds, null, 3)).not.toContain("isn't available this pass");
    const many = Array.from({ length: 12 }, (_, i) => `src/f${i}.ts`);
    expect(rereviewBrief(rounds, many, 3)).not.toContain("isn't available this pass");
  });

  test('a QA fix with little in it is built solo without asking', () => {
    expect(qaFixSoloReason([round(1, 'fail', [CTT_BLOCKER], ['a note'])])).toContain('1 blocking finding and 1 note');
    expect(qaFixSoloReason([round(1, 'fail', [CTT_BLOCKER], ['1', '2', '3', '4', '5'])])).toBeNull();
    expect(qaFixSoloReason([round(1, 'fail', [HL_FORWARD, OTHER_KEYS, CTT_BLOCKER])])).toBeNull();
    expect(qaFixSoloReason([round(1, 'pass-with-notes', [], ['n'])])).toBeNull();
  });

  test('the send-back numbers the notes, asks for tests and opens with the loop', () => {
    const raw = ['---', 'result: fail', 'lint: pass', 'unit-tests: pass', 'blocking-findings:', '  - fix a', 'actionable-notes:', '  - note b', '---', 'body'].join('\n');
    expect(compactQaFindings(raw)).toContain('1. note b');
    expect(compactQaFindings(raw)).toContain('add or change a test that fails without the fix');
    const loop = analyzeQaLoop([round(1, 'fail', [TOTALS_BLOCKER]), round(2, 'fail', [CTT_BLOCKER])], null)!;
    const text = compactQaFindings(raw, loop);
    expect(text).toContain('This branch keeps coming back from QA.');
    expect(text.indexOf(loopBrief(loop))).toBeLessThan(text.indexOf('Fix:'));
  });
});

describe('qaReportIsCurrent', () => {
  const base = { qaReportPath: 'artifacts/qa-reports/x.md', qaRerunPending: false, qaTeam: null, qaRounds: [] as QaRoundRecord[], qaPass: 1 };

  test('a report this pass wrote is current', () => {
    expect(qaReportIsCurrent(base)).toBe(true);
    expect(qaReportIsCurrent({ ...base, qaRounds: [round(1, 'fail', [])] })).toBe(true);
  });

  // Session 7bdd0d9e: the reviewers finished, Bridget read the previous
  // pass's report and stopped, and the coder was sent findings it had fixed.
  test('not while the reviewers’ findings are unwritten, a re-review is pending, or the last round is an earlier pass', () => {
    expect(qaReportIsCurrent({ ...base, qaTeam: { relayed: false } })).toBe(false);
    expect(qaReportIsCurrent({ ...base, qaTeam: { relayed: true } })).toBe(true);
    expect(qaReportIsCurrent({ ...base, qaRerunPending: true })).toBe(false);
    expect(qaReportIsCurrent({ ...base, qaRounds: [round(1, 'fail', [])], qaPass: 2 })).toBe(false);
    expect(qaReportIsCurrent({ ...base, qaReportPath: null })).toBe(false);
  });
});

describe('what a re-review skips', () => {
  const met = (text: string, files: string[]): QaCriterionRecord => ({ text, verdict: 'met', files });
  const previous: QaRoundRecord = {
    ...round(2, 'fail', [CTT_BLOCKER]),
    criteria: [
      met('HL tree is generic', ['parser856.ts']),
      met('Tare is a Pack sibling', ['parser856.ts', 'sample856.ts']),
      met('Panels render per the layout table', ['datasections.tsx', 'sections856.ts']),
      { text: 'Validator flags HL problems', verdict: 'not-met', files: ['validator.ts'] },
      met('Docs to update', []),
    ],
  };

  test('criteria met last pass whose code the fix left alone carry forward', () => {
    const { carried, recheck } = carryForward(previous, ['client/src/features/edi-viewer/DataSections.tsx']);
    expect(carried.map((c) => c.text)).toEqual(['HL tree is generic', 'Tare is a Pack sibling']);
    expect(recheck.map((c) => c.text)).toEqual(['Panels render per the layout table', 'Validator flags HL problems', 'Docs to update']);
  });

  test('an unknown fix re-checks everything', () => {
    expect(carryForward(previous, null).carried).toEqual([]);
    expect(carryForward(undefined, ['a.ts'])).toEqual({ recheck: [], carried: [] });
  });

  test('a small fix is re-reviewed alone', () => {
    const rounds = [round(1, 'fail', [HL_FORWARD]), previous];
    expect(soloRereview(rounds, ['client/src/features/edi-viewer/DataSections.tsx'])).toBe(true);
    // A wide fix that touches most criteria's code is a team's job.
    const many = Array.from({ length: 16 }, (_, i) => `src/f${i}.ts`);
    const wide = [...many, 'lib/parser856.ts', 'lib/sample856.ts', 'DataSections.tsx', 'lib/validator.ts'];
    expect(soloRereview(rounds, wide)).toBe(false);
    expect(soloRereview(rounds, null)).toBe(false);
    // Few criteria left to re-check is small too, however many files moved.
    expect(soloRereview(rounds, many)).toBe(true);
  });

  test('the brief lists the carried criteria and tells a solo lead so', () => {
    const brief = rereviewBrief([round(1, 'fail', [HL_FORWARD]), previous], ['client/src/features/edi-viewer/DataSections.tsx'], 3);
    expect(brief).toContain('## Carried forward from pass 2');
    expect(brief).toContain('- Tare is a Pack sibling');
    expect(brief).toContain('- [not-met] Validator flags HL problems');
    expect(brief).toContain("assign_qa_team isn't available this pass");
  });

  test('the report checklist becomes criteria records', () => {
    const body = [
      '## Acceptance criteria check',
      '- [x] HL tree is generic — client/src/features/edi-viewer/lib/parser856.ts',
      '- [ ] Validator flags HL problems — NOT MET: validator.ts:598 never fires',
      '- [x] Docs to update — carried forward from pass 1',
      '## Findings',
      '- [blocking] something',
    ].join('\n');
    expect(reportCriteria(body)).toEqual([
      { text: 'HL tree is generic', verdict: 'met', files: ['parser856.ts'] },
      { text: 'Validator flags HL problems', verdict: 'not-met', files: ['validator.ts'] },
      { text: 'Docs to update', verdict: 'met', files: [] },
    ]);
  });
});
