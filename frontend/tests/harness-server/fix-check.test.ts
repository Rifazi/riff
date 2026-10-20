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

  test('flags a fix elsewhere in the named file', () => {
    const out = fixCheckProblems(s, diff('src/Panel.tsx', '@@ -200,1 +200,2 @@') + test1);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('src/Panel.tsx:56-63');
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
