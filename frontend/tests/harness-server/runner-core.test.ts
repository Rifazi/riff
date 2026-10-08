import { describe, expect, test } from 'bun:test';

import {
  buildFailureReport,
  groundSummary,
  RUNNER_SUMMARIZE_THRESHOLD,
  shouldSummarizeLog,
} from '../../../harness-server/backend/src/agents/helpers/runner/core';

// The runner helper may only shorten the raw log. The pass/fail line and the
// junit summary are exact, and a summary that dropped them (or said "All
// passed." on a failed run) sent the agent back to re-run the suite.
const header =
  'test:ci failed.\n\n12 tests, 2 failures, 0 errors, 3.1s.\nFailing:\n' +
  'pool.test.ts > closeAllPools — expected 0 to be 1\naudit.test.ts > rejects an unknown region — expected 400, got 502';

describe('buildFailureReport', () => {
  test('keeps the header verbatim above a summary', () => {
    const report = buildFailureReport(header, 'x'.repeat(9000), 'pool.test.ts:30 - expected 0 to be 1');
    expect(report.startsWith(header)).toBe(true);
    expect(report).toContain('pool.test.ts:30 - expected 0 to be 1');
    expect(report).toContain('9000-char log');
  });

  test('sends the log as is without a summary', () => {
    const report = buildFailureReport(header, 'the raw log', null);
    expect(report).toBe(`${header}\n\noutput (errors and summary):\nthe raw log`);
  });

  test('treats a blank summary as no summary', () => {
    expect(buildFailureReport(header, 'log', '  \n')).toBe(buildFailureReport(header, 'log', null));
  });
});

describe('shouldSummarizeLog', () => {
  test('leaves short logs alone', () => {
    expect(shouldSummarizeLog('x'.repeat(3046))).toBe(false);
    expect(shouldSummarizeLog('x'.repeat(RUNNER_SUMMARIZE_THRESHOLD + 1))).toBe(true);
  });
});

// The summaries Qwen wrote in session 2c8f3fdc, against a log shaped like
// that run's: the failing test is in sqlanywhere-pool.test.ts, and the other
// test files only show up in console output.
describe('groundSummary', () => {
  const log =
    'stdout | src/services/comparison-service.test.ts > startAutomaticComparisonJob > looks up the group\n' +
    '[compare:ABCGRP] Finished in 0ms\n\n' +
    ' FAIL  src/db/sqlanywhere-pool.test.ts > closeAllPools > force-closes any still-open short-lived ims connection\n' +
    'AssertionError: expected "connect" to be called 2 times, but got 3 times\n' +
    ' ❯ src/db/sqlanywhere-pool.test.ts:251:34\n';

  test('keeps lines the log backs up', () => {
    const line = 'src/db/sqlanywhere-pool.test.ts > closeAllPools - expected "connect" to be called 2 times';
    expect(groundSummary(line, log)).toBe(line);
    expect(groundSummary('src/db/sqlanywhere-pool.test.ts:251 - expected 2 calls, got 3', log)).not.toBeNull();
  });

  test('drops a test name paired with the wrong file', () => {
    expect(groundSummary('src/services/comparison-service.test.ts > closeAllPools > force-closes any…', log)).toBeNull();
  });

  test('drops a line number the log never mentions', () => {
    expect(groundSummary('src/services/audit-service.test.ts:275 - force-closes any…', log)).toBeNull();
    expect(groundSummary('src/db/sqlanywhere-pool.test.ts:275 - force-closes any…', log)).toBeNull();
  });

  test('drops verdicts and counts but keeps the rest', () => {
    const summary = 'src/db/sqlanywhere-pool.test.ts > closeAllPools - expected 2, got 3\n7 failures\nAll passed.';
    expect(groundSummary(summary, log)).toBe('src/db/sqlanywhere-pool.test.ts > closeAllPools - expected 2, got 3');
    expect(groundSummary('7 failures\nAll passed.', log)).toBeNull();
  });
});
