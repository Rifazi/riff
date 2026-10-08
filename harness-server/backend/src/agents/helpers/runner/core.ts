// Pure half of the runner helper: the Qwen prompt that shortens a failing
// lint/test run's raw log, the threshold at which we bother calling it, and
// how the report the agent sees is put together. No `ai` imports —
// importable from tests.
//
// The pass/fail line and the junit summary (counts plus every failing test
// with its message) are exact and always reach the agent unchanged. Only the
// raw log underneath them is ever summarized: a summary that dropped failures
// or claimed "All passed" on a failed run sent the agent back to re-run the
// suite and re-read the tests to find out what had actually failed.

export const RUNNER_SUMMARIZE_SYSTEM =
  'You are given the raw log of a failed lint or test command. ' +
  'List ONLY the errors in it, one per line: for lint, "file:line - error message"; ' +
  'for tests, "test file > test name - expected/actual or error message". ' +
  'Keep file paths, line numbers and messages exactly as written. Include every error you find. ' +
  'Return only this list — no preamble, no counts, no verdict, no raw output.';

// Only summarize a raw log longer than this. Below it the log costs less
// than what a lossy summary costs when the agent has to re-run to recover it.
export const RUNNER_SUMMARIZE_THRESHOLD = 5_000;

// How much of the log Qwen reads: compacted to this, not to the 3k the agent
// would otherwise get (which never reaches the threshold above), and well
// inside llama-helper's 16k-token context.
export const RUNNER_INPUT_CHARS = 24_000;

export function shouldSummarizeLog(rawLog: string): boolean {
  return rawLog.length > RUNNER_SUMMARIZE_THRESHOLD;
}

const CODE_PATH_RE =
  /[\w@.-]*(?:\/[\w@.-]+)*\.(?:[cm]?[jt]sx?|py|rs|go|java|kt|rb|php|cs|vue|svelte|css|scss|json)\b(?::\d+)?/g;
const VERDICT_RE = /^(all (tests )?passed|no (errors|failures)|\d+ (failures?|errors?|tests?)\b)/i;

// The summary's lines that the log backs up, or null if none are left. Qwen
// has paired a real test name with another file it saw in the log
// ("comparison-service.test.ts > closeAllPools", "audit-service.test.ts:275")
// and closed a failed run with "All passed.", and the agent chased each one.
// So every path:line it names must be in the log, as must the path followed
// by the first segment of a test name; verdict and count lines are dropped,
// since the header above carries the real ones.
export function groundSummary(summary: string, log: string): string | null {
  const flat = log.replace(/[ \t]+/g, ' ');
  const kept = summary
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !VERDICT_RE.test(line.replace(/^[-*•]\s*/, '')))
    .filter((line) => {
      for (const match of line.matchAll(CODE_PATH_RE)) {
        if (!flat.includes(match[0])) return false;
        const testName = line.slice(match.index! + match[0].length).match(/^ > ([^>]+?)(?= > | - |$)/);
        if (testName && !flat.includes(`${match[0]} > ${testName[1].trim()}`)) return false;
      }
      return true;
    });
  return kept.length ? kept.join('\n') : null;
}

// `header` is the exact part (pass/fail line + junit summary); `summary` is
// Qwen's shortening of `rawLog`, or null to send the log as is.
export function buildFailureReport(header: string, rawLog: string, summary: string | null): string {
  if (summary && summary.trim()) {
    return (
      `${header}\n\noutput (errors from the ${rawLog.length}-char log, listed by a local model — ` +
      `trust the counts above over this list):\n${summary.trim()}`
    );
  }
  return `${header}\n\noutput (errors and summary):\n${rawLog}`;
}
