import { describe, expect, test } from 'bun:test';

import { compactOutput } from '../../../harness-server/backend/src/agents/tool-defs/output-compress';

// Shaped like the vitest run in session 2c8f3fdc that hid its failure: the
// code under test logs ISO timestamps from every test (which a bare
// `:\d+:\d+` took for file:line:col), vitest prints the failure to stderr and
// the totals to stdout, and npm's exit report comes last on stderr.
function consoleBlock(n: number): string {
  return (
    `stdout | src/services/audit-service.test.ts > runConsolidatedAuditJob > case ${n}\n` +
    `[audit:us ${n}] Query returned 1 row(s) in 0ms\n` +
    `[audit:us ${n}] First row columns - modified: string("2026-09-01T00:00:00.000Z")\n` +
    `[audit:us ${n}] Saved run #42; saving 1 finding(s)\n`
  );
}

const stdout =
  '\n RUN  v3.2.7 /repo/backend\n\n' +
  Array.from({ length: 40 }, (_, i) => consoleBlock(i)).join('\n') +
  '\n Test Files  1 failed | 20 passed (21)\n      Tests  1 failed | 211 passed (212)\n   Duration  4.1s\n';

const stderr =
  '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯\n\n' +
  ' FAIL  src/db/sqlanywhere-pool.test.ts > closeAllPools > force-closes any still-open short-lived ims connection\n' +
  'AssertionError: expected "connect" to be called 2 times, but got 3 times\n' +
  ' ❯ src/db/sqlanywhere-pool.test.ts:251:34\n\n' +
  Array.from({ length: 10 }, (_, i) => `stderr | src/x.test.ts > noisy ${i}\nwarn at 2026-09-01T00:00:00Z\n`).join('\n') +
  '\nnpm error Lifecycle script `test:ci` failed with error:\n' +
  'npm error code 1\n' +
  'npm error path /repo/backend\n' +
  'npm error workspace mobilink-audit-backend@0.1.0\n' +
  'npm error location /repo/backend\n' +
  'npm error command failed\n' +
  'npm error command sh -c vitest run --passWithNoTests\n';

describe('compactOutput', () => {
  const out = compactOutput(stdout, stderr);

  test('keeps the failure, its location and the totals', () => {
    expect(out).toContain('FAIL  src/db/sqlanywhere-pool.test.ts > closeAllPools');
    expect(out).toContain('expected "connect" to be called 2 times, but got 3 times');
    expect(out).toContain('src/db/sqlanywhere-pool.test.ts:251:34');
    expect(out).toContain('Tests  1 failed | 211 passed (212)');
  });

  test("drops the test's console output and npm's repeated exit lines", () => {
    expect(out).not.toContain('Query returned');
    expect(out).not.toContain('2026-09-01T00:00:00');
    expect(out).not.toContain('npm error code 1');
    expect(out).not.toContain('npm error command');
    expect(out).toContain('npm error workspace mobilink-audit-backend@0.1.0');
  });

  test('fits the budget without cutting a line in half', () => {
    expect(out.length).toBeLessThanOrEqual(3000);
    const lines = new Set([...stdout.split('\n'), ...stderr.split('\n')].map((l) => l.trimEnd()));
    for (const line of out.split('\n')) {
      if (!line.startsWith('[… ')) expect(lines.has(line)).toBe(true);
    }
  });

  test('returns a short log whole, console output included', () => {
    expect(compactOutput(consoleBlock(1), 'boom')).toBe(`${consoleBlock(1).trimEnd()}\nboom`);
  });

  test('a tight budget keeps the totals first', () => {
    const tiny = compactOutput(stdout, stderr, 400);
    expect(tiny.length).toBeLessThanOrEqual(400);
    expect(tiny).toContain('Tests  1 failed | 211 passed (212)');
  });
});
