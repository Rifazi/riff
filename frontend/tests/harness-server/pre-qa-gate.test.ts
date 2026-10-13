import { describe, expect, test } from 'bun:test';

import {
  blockingAuditProblems,
  checkSucceeded,
  gateMessage,
  gateSummary,
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
    { kind: 'docs' as const, file: 'server/src/pages/DOMAIN.md', domain: 'pages', message: 'Files section is stale' },
    { kind: 'docs' as const, file: 'server/src/billing/DOMAIN.md', domain: 'billing', message: 'Files section is stale' },
    { kind: 'map' as const, file: 'MAP.md', domain: null, message: 'pages is missing from MAP.md' },
  ];

  test('keeps MAP.md and touched domains, drops untouched ones', () => {
    const lines = blockingAuditProblems(audit(problems), scope(['pages']));
    expect(lines).toEqual(['[docs] server/src/pages/DOMAIN.md: Files section is stale', '[map] MAP.md: pages is missing from MAP.md']);
  });

  test('changed code with no DOMAIN.md blocks', () => {
    const lines = blockingAuditProblems(audit([]), scope([], [{ folder: 'client/src/views/PagesSidebar', parent: 'views', files: ['a.tsx'] }]));
    expect(lines).toEqual(['[map] client/src/views/PagesSidebar/ has changed code but no DOMAIN.md (child domain of views)']);
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
      ['[docs] a/DOMAIN.md: Files section is stale'],
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

// The Rename & Delete session's real mismatch: DOMAIN.md said "… project id".
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
