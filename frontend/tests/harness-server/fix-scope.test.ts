import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { findingRefs, fixContext, fixScopeFor, inFixScope } from '../../../harness-server/backend/src/agents/fix-scope';
import type { QaRoundRecord } from '../../../harness-server/backend/src/sessions/qa-loop';

// Findings as QA wrote them in session 7bdd0d9e.
const CTT =
  "client/src/features/edi-viewer/DataSections.tsx:61 — the Totals panel's 856 fallback reads " +
  "`find(...,'CTT')?.elements[1]`, which is CTT02; validator.ts:578 uses `ctt.elements[0]` for CTT01. Change to `elements[0]`.";
const SHIPMENTS = "client/src/features/edi-viewer/DataSections.tsx sectionPreview (~line 33-65): no 'shipments' case.";
const HL = 'client/src/features/edi-viewer/lib/parser856.ts:220-230 + validator.ts:598-607 — an HL02 that references a later HL01.';
const KEYS = 'client/src/features/edi-viewer/lib/sections.ts (HL_KEYS_856, ~line 418): `other` is missing; add it to node.other handling.';

describe('findingRefs', () => {
  test('paths with :line, :from-to and (~line a-b) hints', () => {
    expect(findingRefs(CTT)).toEqual([
      { path: 'client/src/features/edi-viewer/DataSections.tsx', lines: [61, 61] },
      { path: 'validator.ts', lines: [578, 578] },
    ]);
    expect(findingRefs(SHIPMENTS)).toEqual([{ path: 'client/src/features/edi-viewer/DataSections.tsx', lines: [33, 65] }]);
    expect(findingRefs(HL)).toEqual([
      { path: 'client/src/features/edi-viewer/lib/parser856.ts', lines: [220, 230] },
      { path: 'validator.ts', lines: [598, 607] },
    ]);
  });

  test('a dotted identifier is not a file', () => {
    expect(findingRefs(KEYS)).toEqual([{ path: 'client/src/features/edi-viewer/lib/sections.ts', lines: [418, 418] }]);
  });
});

describe('inFixScope', () => {
  const scope = ['client/src/features/edi-viewer/DataSections.tsx', 'server/src/lib'];

  test('the named file, its tests and fixtures, and anything under a named folder', () => {
    expect(inFixScope('client/src/features/edi-viewer/DataSections.tsx', scope)).toBe(true);
    expect(inFixScope('client/src/features/edi-viewer/DataSections.test.tsx', scope)).toBe(true);
    expect(inFixScope('client/src/features/edi-viewer/__tests__/DataSections.spec.tsx', scope)).toBe(true);
    expect(inFixScope('server/src/lib/deep/x.ts', scope)).toBe(true);
  });

  test('not a neighbour, a test of another file, or a folder with a longer name', () => {
    expect(inFixScope('client/src/features/edi-viewer/ShipmentTree.tsx', scope)).toBe(false);
    expect(inFixScope('client/src/features/edi-viewer/ShipmentTree.test.tsx', scope)).toBe(false);
    expect(inFixScope('server/src/library/x.ts', scope)).toBe(false);
  });
});

describe('fixScopeFor and fixContext', () => {
  let repo: string;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' }).toString();
  const write = (file: string, text: string) => {
    mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    writeFileSync(path.join(repo, file), text);
  };
  const round = (blocking: string[], notes: string[] = []): QaRoundRecord => ({ pass: 2, at: '2026-10-14T20:00:00Z', result: 'fail', blocking, notes, head: null });

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), 'fix-scope-'));
    git('init', '-q', '-b', 'master');
    write('client/src/features/edi-viewer/DataSections.tsx', Array.from({ length: 80 }, (_, i) => `line ${i + 1}`).join('\n'));
    write('client/src/features/edi-viewer/lib/validator.ts', Array.from({ length: 20 }, (_, i) => `v ${i + 1}`).join('\n'));
    write('docs/edi-viewer.md', '# docs\n');
    git('add', '.');
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  test('resolves bare file names to the one tracked file and fences on the blockers', async () => {
    const scope = (await fixScopeFor(repo, round([CTT], ['docs/edi-viewer.md should mention it'])))!;
    expect(scope.fenced).toBe(true);
    expect(scope.paths).toEqual(['client/src/features/edi-viewer/DataSections.tsx', 'client/src/features/edi-viewer/lib/validator.ts', 'docs/edi-viewer.md']);
  });

  test('a blocker that names no file leaves the write tools unfenced', async () => {
    const scope = (await fixScopeFor(repo, round([CTT, 'lint fails on the branch'])))!;
    expect(scope.fenced).toBe(false);
    expect(scope.paths).toContain('client/src/features/edi-viewer/DataSections.tsx');
  });

  test('the context shows the lines each finding points at', async () => {
    const scope = (await fixScopeFor(repo, round([CTT])))!;
    const text = await fixContext(repo, scope);
    expect(text).toContain('client/src/features/edi-viewer/DataSections.tsx:53-69');
    expect(text).toContain('61 | line 61');
    expect(text).not.toContain('line 52\n');
    expect(text).toContain('client/src/features/edi-viewer/lib/validator.ts: line 578 is past the end (20 lines)');
    expect(text).toContain('Your write tools accept only these files');
  });

  test('nothing to scope without findings', async () => {
    expect(await fixScopeFor(repo, round([]))).toBeNull();
    expect(await fixScopeFor(repo, undefined)).toBeNull();
  });
});
