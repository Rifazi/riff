import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { tool } from 'ai';
import { z } from 'zod';
import { diffAgainstBase, diffStatAgainstBase } from '../../repo/git.js';
import { compactDiff, compactOutput, NOISE_PATHSPECS } from './output-compress.js';
import { reportHelperRun, type HelperContext } from '../helpers/helper.js';
import { generateLocal } from '../local-llm.js';
import {
  RUNNER_INPUT_CHARS,
  RUNNER_SUMMARIZE_SYSTEM,
  buildFailureReport,
  groundSummary,
  shouldSummarizeLog,
} from '../helpers/runner/core.js';

const execFileAsync = promisify(execFile);

export type CheckCommand = 'lint' | 'test' | 'test:integration';

// Legacy defaults — the original Customer-EDI-shaped repo's own script
// names. An app can override any of these (see apps/apps.ts's
// CheckCommands) when its root package.json uses different script names;
// the command set the model chooses from stays this fixed 3-value enum
// either way (see the comment on createQaExecutors below).
const DEFAULT_SCRIPTS: Record<CheckCommand, string> = {
  lint: 'lint',
  test: 'test:ci',
  'test:integration': 'test:integration',
};

const TIMEOUTS_MS: Record<CheckCommand, number> = {
  lint: 60_000,
  test: 300_000,
  'test:integration': 600_000,
};

// Diff-body cap for the no-path call. Anything past it is still reachable
// per file via `path`, so this only trims what gets pushed unasked.
const DIFF_CHAR_LIMIT = 25_000;
const OVERVIEW_CONTEXT_LINES = 1;

// Changed files that are nearly always noise to review line by line. They
// still show up in the stat, and `path` fetches any of them on request.
const DIFF_NOISE_EXCLUDES = NOISE_PATHSPECS;

// The first line of a junit <failure>/<error>: its message attribute, else
// its text (the assertion line in vitest/jest output), cut to 200 chars.
function firstFailureLine(failure: unknown): string {
  const node = Array.isArray(failure) ? failure[0] : failure;
  const text =
    typeof node === 'string'
      ? node
      : typeof node === 'object' && node !== null
        ? String((node as Record<string, unknown>)['@_message'] ?? (node as Record<string, unknown>)['#text'] ?? '')
        : '';
  const line = text.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

function parseJunitSummary(xml: string): string {
  try {
    const parser = new XMLParser({ ignoreAttributes: false });
    const parsed = parser.parse(xml);
    const suites = parsed.testsuites;
    const attrs = suites?.['@_tests'] !== undefined ? suites : suites?.testsuite;
    if (!attrs) return 'Could not parse junit.xml summary.';
    const tests = suites['@_tests'] ?? 0;
    const failures = suites['@_failures'] ?? 0;
    const errors = suites['@_errors'] ?? 0;
    const time = suites['@_time'] ?? '?';

    const failingNames: string[] = [];
    const testsuiteList = Array.isArray(suites.testsuite) ? suites.testsuite : [suites.testsuite].filter(Boolean);
    for (const suite of testsuiteList) {
      const cases = Array.isArray(suite?.testcase) ? suite.testcase : [suite?.testcase].filter(Boolean);
      for (const testcase of cases) {
        const failure = testcase?.failure ?? testcase?.error;
        if (failure) {
          const reason = firstFailureLine(failure);
          failingNames.push(`${suite['@_name'] ?? ''} > ${testcase['@_name'] ?? ''}${reason ? ` — ${reason}` : ''}`);
        }
      }
    }

    let summary = `${tests} tests, ${failures} failures, ${errors} errors, ${time}s.`;
    if (failingNames.length > 0) {
      summary += `\nFailing:\n${failingNames.slice(0, 30).join('\n')}`;
    }
    return summary;
  } catch {
    return 'Could not parse junit.xml summary.';
  }
}

// The junit summary of this run, or null when the run didn't write one. A
// junit.xml older than the run is a previous run's and would report its
// results as this one's.
async function readJunitSummary(repoRoot: string, startedAt: number): Promise<string | null> {
  const file = path.join(repoRoot, 'junit.xml');
  try {
    const stat = await fs.stat(file);
    if (stat.mtimeMs < startedAt) return null;
    return parseJunitSummary(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

export const runCheckedCommandSchema = z.object({ command: z.enum(['lint', 'test', 'test:integration']) });
export const runCheckedCommandDescription =
  'Run one of the repo\'s checks via its configured npm script: "lint", "test" (unit suite, pass/fail summary), ' +
  'or "test:integration" (slow, may need credentials — only when the diff touches integration-sensitive code).';

export const getDiffSchema = z.object({
  branchName: z.string(),
  path: z.string().optional().describe('Repo-relative file path — return only this file\'s diff'),
});
export const getDiffDescription =
  'Get the stat summary and diff between the app\'s base branch and this session\'s branch — the actual change set to ' +
  'review, not the coding agent\'s self-report. Lockfiles, snapshots and build output are listed in the stat but left ' +
  `out of the diff body, which shows one line of context and is capped at ${DIFF_CHAR_LIMIT} chars; pass \`path\` to get ` +
  "one file's diff in full, with three lines of context.";

/**
 * Closed enum, not a free-form command string — the actual safety mechanism.
 * Runs via execFile (argv array), never shell interpolation. A failing
 * lint/test run is informative content the QA agent needs to see and reason
 * about, not a tool-execution error, so this always returns normally
 * (pass/fail is embedded in the text) rather than throwing.
 */
export function createQaExecutors(deps: { repoRoot: string; baseBranch?: string; checkCommands?: Partial<Record<CheckCommand, string>>; helperContext?: HelperContext }) {
  const runCheckedCommandExecute = async ({ command }: z.infer<typeof runCheckedCommandSchema>): Promise<string> => {
    const script = deps.checkCommands?.[command] ?? DEFAULT_SCRIPTS[command];
    const timeoutMs = TIMEOUTS_MS[command];
    // Whole seconds: some filesystems store mtimes that coarsely.
    const startedAt = Math.floor(Date.now() / 1000) * 1000;
    try {
      const { stdout, stderr } = await execFileAsync('npm', ['run', script], {
        cwd: deps.repoRoot,
        timeout: timeoutMs,
        maxBuffer: 10_000_000,
      });
      let text = `${script} succeeded.`;
      if (command === 'test') {
        text += `\n\n${(await readJunitSummary(deps.repoRoot, startedAt)) ?? '(no junit.xml found to summarize)'}`;
      }
      // A passing run's log is noise the model re-reads on every later step —
      // the pass/fail line (and junit summary) is all it needs.
      return text;
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; killed?: boolean; message?: string };
      const timedOut = e.killed ? ' (TIMED OUT)' : '';
      let text = `${script} failed${timedOut}.`;
      if (command === 'test') {
        const junit = await readJunitSummary(deps.repoRoot, startedAt);
        if (junit) text += `\n\n${junit}`;
      }
      const stdout = e.stdout ?? '';
      const stderr = e.stderr ?? e.message ?? '';
      const rawLog = compactOutput(stdout, stderr);

      // A long log is shortened by the local Qwen, which reads far more of
      // it than the agent's 3k excerpt. The pass/fail line and junit summary
      // above it always go through unchanged, and only the summary lines the
      // log backs up are kept — see helpers/runner/core.ts.
      const fullLog = compactOutput(stdout, stderr, RUNNER_INPUT_CHARS);
      if (deps.helperContext && shouldSummarizeLog(fullLog)) {
        try {
          const answer = (await generateLocal({ system: RUNNER_SUMMARIZE_SYSTEM, prompt: fullLog, maxTokens: 600 })).trim();
          const summary = answer ? groundSummary(answer, fullLog) : null;
          if (summary) {
            await reportHelperRun(
              deps.helperContext,
              { helper: 'runner', model: 'builtin', tasks: 1, useful: 1, readChars: fullLog.length, returnedChars: summary.length, savedTokens: Math.max(0, Math.round((fullLog.length - summary.length) / 4)) },
              `Runner helper: summarized ${command} output (${fullLog.length} → ${summary.length} chars)`,
            );
            return buildFailureReport(text, fullLog, summary);
          }
          if (answer) {
            await reportHelperRun(
              deps.helperContext,
              { helper: 'runner', model: 'builtin', tasks: 1, useful: 0, readChars: fullLog.length, returnedChars: 0, savedTokens: 0 },
              `Runner helper: its ${command} summary didn't match the log, so the log excerpt was sent instead`,
            );
          }
        } catch {
          // Qwen unavailable — fall through to the compacted log
        }
      }

      return buildFailureReport(text, rawLog, null);
    }
  };

  const getDiffExecute = async ({ branchName, path: filePath }: z.infer<typeof getDiffSchema>): Promise<string> => {
    if (filePath) {
      const diff = compactDiff(await diffAgainstBase(deps.repoRoot, branchName, deps.baseBranch, [filePath]));
      return diff.trim() ? diff.slice(0, 60_000) : `No changes to ${filePath} on this branch.`;
    }
    // One line of context instead of git's three in the overview; `path`
    // returns a file's diff with full context.
    const [rawDiff, stat] = await Promise.all([
      diffAgainstBase(deps.repoRoot, branchName, deps.baseBranch, DIFF_NOISE_EXCLUDES, OVERVIEW_CONTEXT_LINES),
      diffStatAgainstBase(deps.repoRoot, branchName, deps.baseBranch),
    ]);
    const diff = compactDiff(rawDiff);
    if (diff.length <= DIFF_CHAR_LIMIT) return `${stat}\n\n${diff}`;
    return (
      `${stat}\n\n${diff.slice(0, DIFF_CHAR_LIMIT)}\n\n[diff truncated at ${DIFF_CHAR_LIMIT} of ${diff.length} chars — ` +
      'call get_diff again with `path` for any file in the stat above that was cut off]'
    );
  };

  return { runCheckedCommandExecute, getDiffExecute };
}

export function createQaTools(deps: { repoRoot: string; baseBranch?: string; checkCommands?: Partial<Record<CheckCommand, string>>; helperContext?: HelperContext }) {
  const { runCheckedCommandExecute, getDiffExecute } = createQaExecutors(deps);
  return {
    runCheckedCommandTool: tool({
      description: runCheckedCommandDescription,
      inputSchema: runCheckedCommandSchema,
      execute: runCheckedCommandExecute,
    }),
    getDiffTool: tool({ description: getDiffDescription, inputSchema: getDiffSchema, execute: getDiffExecute }),
  };
}
