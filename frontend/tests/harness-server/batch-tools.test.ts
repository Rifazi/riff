import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createFileExecutors } from '../../../harness-server/backend/src/agents/tool-defs/file-tools';
import { createSearchCodeExecute } from '../../../harness-server/backend/src/agents/tool-defs/code-search-tool';
import { workingSetRanges } from '../../../harness-server/backend/src/agents/working-set';

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'batch-tools-'));
  writeFileSync(path.join(root, 'a.ts'), 'export const alpha = 1;\nexport function beta() {}\n');
  writeFileSync(path.join(root, 'b.ts'), 'export const gamma = 2;\n');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('read_files', () => {
  test('returns every file under its own heading and reports a failure in place', async () => {
    const { readFilesExecute } = createFileExecutors({ repoRoot: root });
    const out = await readFilesExecute({ files: [{ path: 'a.ts' }, { path: 'missing.ts' }, { path: 'b.ts', symbol: 'gamma' }] });
    expect(out).toContain('=== a.ts ===\nexport const alpha');
    expect(out).toMatch(/=== missing\.ts ===\nFailed: /);
    expect(out).toContain('=== b.ts (gamma) ===');
    expect(out).toContain('export const gamma');
  });

  test('is read like read_file by the working set', async () => {
    const { readFilesExecute } = createFileExecutors({ repoRoot: root });
    const input = { files: [{ path: 'a.ts', offset: 2, limit: 1 }, { path: 'missing.ts' }, { path: 'b.ts' }] };
    const text = await readFilesExecute(input);
    const entries = [
      { role: 'tool_call', toolName: 'read_files', toolInput: input, toolCallId: '1' },
      { role: 'tool_result', toolResult: [{ type: 'text', text }], toolCallId: '1' },
    ];
    const ranges = workingSetRanges(entries as never);
    expect(ranges.map((r) => r.path).sort()).toEqual(['a.ts', 'b.ts']);
  });
});

describe('search_code also', () => {
  test('answers each pattern under its own heading', async () => {
    const search = createSearchCodeExecute({ repoRoot: root });
    const out = await search({ query: 'alpha', also: ['gamma', 'nothing-here'] });
    expect(out).toContain('## alpha');
    expect(out).toContain('## gamma');
    expect(out).toContain('a.ts');
    expect(out).toContain('b.ts');
    expect(out).toContain('No matches for "nothing-here"');
  });

  test('a call without also is unchanged', async () => {
    const search = createSearchCodeExecute({ repoRoot: root });
    expect(await search({ query: 'alpha' })).not.toContain('##');
  });
});

describe('trimAudit', () => {
  const audit = `Wayfinding audit\n\nDomains:\n- a (a/)\n- b (b/)\n\nProblems:\n- [x] one`;

  test('a repeat is a note, and a later audit leaves out the domain list', async () => {
    const { trimAudit } = await import('../../../harness-server/backend/src/agents/tool-defs/architecture-audit-tool');
    expect(trimAudit(audit, null)).toBe(audit);
    expect(trimAudit(audit, audit)).toContain('unchanged');
    const later = trimAudit(`${audit}\n- [y] two`, audit);
    expect(later).not.toContain('- a (a/)');
    expect(later).toContain('[y] two');
  });

  test('cuts a very long result at a line', async () => {
    const { trimAudit } = await import('../../../harness-server/backend/src/agents/tool-defs/architecture-audit-tool');
    const out = trimAudit(Array.from({ length: 2000 }, (_, i) => `- problem ${i}`).join('\n'), null);
    expect(out.length).toBeLessThan(10_500);
    expect(out).toContain('more characters cut');
  });
});
