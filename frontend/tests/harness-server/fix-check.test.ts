import { describe, expect, test } from 'bun:test';

import { fixCheckProblems, parseHunks } from '../../../harness-server/backend/src/agents/fix-check';
import type { FixScopeInfo } from '../../../harness-server/backend/src/agents/fix-scope';
import { compactQaFindings, isActionableNote, parseQaReport } from '../../../harness-server/backend/src/sessions/qa-findings';

const scope = (text: string, path: string, lines: [number, number] | null): FixScopeInfo => ({
  paths: [path],
  fenced: true,
  findings: [{ kind: 'blocking', text, refs: [{ path, lines }] }],
});

const diff = (file: string, hunk: string) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n${hunk}\n+x\n`;

describe('parseHunks', () => {
  test('reads old and new ranges, with a default length of one line', () => {
    const h = parseHunks(diff('a.ts', '@@ -56,2 +56,4 @@') + diff('b.ts', '@@ -3 +3 @@'));
    expect(h.get('a.ts')).toEqual([{ oldStart: 56, oldEnd: 57, newStart: 56, newEnd: 59 }]);
    expect(h.get('b.ts')).toEqual([{ oldStart: 3, oldEnd: 3, newStart: 3, newEnd: 3 }]);
  });
});

describe('fixCheckProblems', () => {
  const s = scope('autosave loop', 'src/Panel.tsx', [56, 63]);
  const test1 = diff('src/Panel.test.tsx', '@@ -1 +1 @@');

  test('passes when a hunk lands near the named lines and a test changed', () => {
    expect(fixCheckProblems(s, diff('src/Panel.tsx', '@@ -60,1 +60,2 @@') + test1)).toEqual([]);
  });

  test('a test added next to the named file answers a blocker that asks for a test', () => {
    const ask: FixScopeInfo = { paths: [], fenced: true, findings: [{ kind: 'blocking', text: 'add a test for the label', refs: [{ path: 'src/Panel.tsx', lines: [56, 63] }] }] };
    expect(fixCheckProblems(ask, test1)).toEqual([]);
  });

  test('flags a fix elsewhere in the named file', () => {
    const out = fixCheckProblems(s, diff('src/Panel.tsx', '@@ -200,1 +200,2 @@') + test1);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('src/Panel.tsx:56-63');
  });

  test('a note_for_qa that names the blocker\'s file answers it, with no test needed', () => {
    const d = diff('src/Other.ts', '@@ -1 +1 @@');
    expect(fixCheckProblems(s, d)).not.toEqual([]);
    expect(fixCheckProblems(s, d, ['src/Panel.tsx lines 56-63 hold no such code; that spot is wrong'])).toEqual([]);
    expect(fixCheckProblems(s, d, ['unrelated note about src/Elsewhere.ts'])).not.toEqual([]);
  });

  test('flags a fix that changed no test', () => {
    const out = fixCheckProblems(s, diff('src/Panel.tsx', '@@ -60 +60 @@'));
    expect(out.join('\n')).toContain('changed no test');
  });

  test('a finding with no file reference is not checked', () => {
    const none: FixScopeInfo = { paths: [], fenced: false, findings: [{ kind: 'blocking', text: 'x', refs: [] }] };
    expect(fixCheckProblems(none, test1)).toEqual([]);
  });
});

describe('non-actionable notes', () => {
  test('drops what the coder cannot act on', () => {
    expect(isActionableNote('Visual verification outstanding: no screenshot tool available, the human should eyeball /login')).toBe(false);
    expect(isActionableNote("App configuration — the source-folder setting is `src/`")).toBe(false);
    expect(isActionableNote('src/a.ts:4 — add a test for the empty case')).toBe(true);
  });

  test('parseQaReport and compactQaFindings leave them out', () => {
    const raw = `---\nresult: pass\nactionable-notes:\n  - "no screenshot tool available; human should eyeball it"\n  - "src/a.ts:4 add a test"\n---\nbody`;
    expect(parseQaReport(raw).notes).toEqual(['src/a.ts:4 add a test']);
    expect(compactQaFindings(raw)).not.toContain('screenshot');
  });
});

describe('respond_to_qa answers', () => {
  const s = scope('autosave loop', 'src/Panel.tsx', [56, 63]);
  const resp = (status: 'fixed' | 'disputed' | 'blocked') => [{ blocker: 1, status }];

  test('a blocker with no answer is flagged even when nothing else is wrong', () => {
    const out = fixCheckProblems(s, '', [], []);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('respond_to_qa');
  });

  test('a dispute or blocked answer needs no diff: QA rules on it', () => {
    expect(fixCheckProblems(s, '', [], resp('disputed'))).toEqual([]);
    expect(fixCheckProblems(s, '', [], resp('blocked'))).toEqual([]);
  });

  test('a claimed fix is still checked against the diff', () => {
    expect(fixCheckProblems(s, '', [], resp('fixed'))).toHaveLength(1);
  });

  test('the send-back shows the coder its own earlier answer beside the blocker', () => {
    const report = '---\nresult: fail\nblocking-findings:\n  - "src/Panel.tsx:56-63 autosave loop never stops"\n---\nbody';
    const text = compactQaFindings(report, null, [], [
      { pass: 1, blocker: 1, finding: 'src/Panel.tsx:56-63 autosave loop never stops', status: 'disputed', explanation: 'the effect cleans up on unmount', evidence: 'Panel.tsx:70', at: '' },
    ]);
    expect(text).toContain('1. src/Panel.tsx:56-63 autosave loop never stops');
    expect(text).toContain('You answered this (disputed): the effect cleans up on unmount');
  });
});
