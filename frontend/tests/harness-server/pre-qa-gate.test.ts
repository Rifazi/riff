import { describe, expect, test } from 'bun:test';

import {
  blockingAuditProblems,
  checkSucceeded,
  docsToUpdate,
  untouchedDocs,
  gateFingerprint,
  gateMessage,
  gateStopReason,
  gateStuck,
  gateSummary,
  problemKey,
} from '../../../harness-server/backend/src/agents/pre-qa-gate-core';
import { closestTestName, type BranchScope, type WayfindingAudit } from '../../../harness-server/backend/src/architecture/wayfinding-audit';

// run_checked_command's report, as the gate and the QA team read it.
describe('checkSucceeded', () => {
  test('reads the status line', () => {
    expect(checkSucceeded('lint succeeded.')).toBe(true);
    expect(checkSucceeded('test failed.\n\n2 failed')).toBe(false);
    expect(checkSucceeded('test failed (TIMED OUT).')).toBe(false);
  });

  test('finds the status line after install notes', () => {
    expect(checkSucceeded('Installed dependencies in client.\nInstalled dependencies in server.\n\nlint succeeded.')).toBe(true);
    expect(checkSucceeded('Installed dependencies in client.\n\ntest:ci failed.')).toBe(false);
  });

  test('an unrecognisable report is a failure', () => {
    expect(checkSucceeded('npm ERR! something')).toBe(false);
  });
});

const audit = (problems: WayfindingAudit['problems']) => ({ problems }) as unknown as WayfindingAudit;
const scope = (domains: string[], offMap: BranchScope['offMap'] = []) =>
  ({ base: 'main', byDomain: domains.map((domain) => ({ domain, files: [] })), outside: [], offMap, ownershipEdits: [], structural: [] }) as BranchScope;

describe('blockingAuditProblems', () => {
  const problems = [
    { kind: 'docs' as const, file: 'server/src/pages/README.md', domain: 'pages', message: 'Files section is stale' },
    { kind: 'docs' as const, file: 'server/src/billing/README.md', domain: 'billing', message: 'Files section is stale' },
    { kind: 'map' as const, file: 'MAP.md', domain: null, message: 'pages is missing from MAP.md' },
  ];

  test('keeps MAP.md and touched domains, drops untouched ones', () => {
    const lines = blockingAuditProblems(audit(problems), scope(['pages']));
    expect(lines).toEqual(['[docs] server/src/pages/README.md: Files section is stale', '[map] MAP.md: pages is missing from MAP.md']);
  });

  test('changed code with no README.md blocks', () => {
    const lines = blockingAuditProblems(audit([]), scope([], [{ folder: 'client/src/views/PagesSidebar', parent: 'views', files: ['a.tsx'] }]));
    expect(lines).toEqual(['[map] client/src/views/PagesSidebar/ has changed code but no README.md (child domain of views)']);
  });

  test('without a branch scope every problem counts', () => {
    expect(blockingAuditProblems(audit(problems), null).length).toBe(3);
  });
});

describe('gateMessage', () => {
  test('null when everything passes', () => {
    expect(gateMessage([{ label: 'lint', passed: true, output: 'lint succeeded.' }], [])).toBeNull();
  });

  test('carries only the failing output', () => {
    const message = gateMessage(
      [
        { label: 'lint', passed: true, output: 'lint succeeded.' },
        { label: 'unit tests', passed: false, output: 'test failed.\n\nPagesSidebar › relabels after delete' },
      ],
      ['[docs] a/README.md: Files section is stale'],
    )!;
    expect(message).toContain('## unit tests');
    expect(message).toContain('relabels after delete');
    expect(message).not.toContain('## lint');
    expect(message).toContain('## audit_architecture (1 problem(s) on this branch)');
    expect(message).toContain('regenerate: true');
  });

  test('caps a long audit list', () => {
    const many = Array.from({ length: 30 }, (_, i) => `[docs] p${i}`);
    const message = gateMessage([], many)!;
    expect(message).toContain('- [docs] p24');
    expect(message).not.toContain('- [docs] p25');
    expect(message).toContain('… 5 more');
  });
});

describe('gateSummary', () => {
  test('names what failed', () => {
    expect(gateSummary([{ label: 'lint', passed: false, output: '' }, { label: 'unit tests', passed: true, output: '' }], ['x', 'y'])).toBe('lint, audit (2) failed');
    expect(gateSummary([{ label: 'lint', passed: true, output: '' }], [])).toBe('lint, tests and audit pass');
  });
});

// The Rename & Delete session's real mismatch: README.md said "… project id".
describe('closestTestName', () => {
  const body = `
describe('rename', () => {
  it('returns 404 when renaming a soft-deleted project', async () => {});
  it('rejects an empty name', async () => {});
  test("trims the new name", () => {});
});`;

  test('finds a reworded test', () => {
    expect(closestTestName(body, 'returns 404 when renaming a soft-deleted project id')).toBe('returns 404 when renaming a soft-deleted project');
  });

  test('null when nothing is close', () => {
    expect(closestTestName(body, 'caps discount at $50')).toBeNull();
  });
});

describe('baseline problems', () => {
  const problems = [
    { kind: 'structure' as const, file: 'src/infra/stack.ts', domain: 'infra', message: 'imports src/auth/backend.ts: reaches a private file of auth' },
    { kind: 'docs' as const, file: 'src/infra/README.md', domain: 'infra', message: 'Files section is stale' },
  ];

  test('a problem the base branch already has never blocks', () => {
    const baseline = new Set([problemKey(problems[0])]);
    expect(blockingAuditProblems(audit(problems), null, baseline)).toEqual(['[docs] src/infra/README.md: Files section is stale']);
  });

  test('wrapping differences do not make a problem new', () => {
    expect(problemKey({ ...problems[0], message: 'imports src/auth/backend.ts:\n  reaches a private file of auth' })).toBe(
      problemKey({ ...problems[0], message: 'imports src/auth/backend.ts: reaches a private file of auth' })
    );
  });
});

describe('fix passes that change nothing', () => {
  const failing = (label: string) => ({ label, passed: false, output: 'x' });

  test('the same failures twice is stuck, fewer or different is not', () => {
    const first = gateFingerprint([failing('lint')], ['[docs] a', '[docs] b']);
    expect(gateStuck(null, first)).toBe(false);
    expect(gateStuck(first, gateFingerprint([failing('lint')], ['[docs] b', '[docs] a']))).toBe(true);
    expect(gateStuck(first, gateFingerprint([failing('lint')], ['[docs] a']))).toBe(false);
    expect(gateStuck(first, gateFingerprint([], ['[docs] a', '[docs] c']))).toBe(false);
  });

  test('the stop reason lists the problems', () => {
    const reason = gateStopReason('audit (2) failed', ['[docs] a', '[docs] b'], 'stuck', 1);
    expect(reason).toContain('exactly the same way');
    expect(reason).toContain('- [docs] b');
    expect(gateStopReason('lint failed', [], 'limit', 2)).toContain('after 2 fix passes');
  });
});

describe('docs to update', () => {
  const doc = [
    '## Acceptance criteria',
    '- [ ] a.md is mentioned here',
    '',
    '## Docs to update',
    '- docs/architecture.md — add the new route',
    '- `README.md`: mention the flag',
    '* **docs/api/orders.md** — new field',
    '- none — nothing else',
    '',
    '## Links',
    '- docs/other.md',
  ].join('\n');

  test('lists the paths in the section only', () => {
    expect(docsToUpdate(doc)).toEqual(['docs/architecture.md', 'README.md', 'docs/api/orders.md']);
  });

  test('"none" and a missing section list nothing', () => {
    expect(docsToUpdate('## Docs to update\n- none — no doc describes this\n')).toEqual([]);
    expect(docsToUpdate('# Title\n')).toEqual([]);
  });

  test('untouched docs are the listed ones not in the changed files', () => {
    expect(untouchedDocs(['docs/a.md', 'README.md'], ['src/x.ts', 'docs/a.md'])).toEqual(['README.md']);
    expect(untouchedDocs(['docs/a.md'], ['app/docs/a.md'])).toEqual([]);
  });
});
