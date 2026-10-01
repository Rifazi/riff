import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { tool } from 'ai';
import { z } from 'zod';
import { diffAgainstBase, diffStatAgainstBase } from '../../repo/git.js';
import { compactDiff, compactOutput } from './output-compress.js';

const execFileAsync = promisify(execFile);

type CheckCommand = 'lint' | 'test' | 'test:integration';

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
const DIFF_NOISE_EXCLUDES = [
  ':(exclude,glob)**/package-lock.json',
  ':(exclude,glob)**/pnpm-lock.yaml',
  ':(exclude,glob)**/yarn.lock',
  ':(exclude,glob)**/Cargo.lock',
  ':(exclude,glob)**/*.snap',
  ':(exclude,glob)**/__snapshots__/**',
  ':(exclude,glob)**/dist/**',
  ':(exclude,glob)**/build/**',
  ':(exclude,glob)**/*.min.js',
  ':(exclude,glob)**/*.map',
];

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
        if (testcase?.failure || testcase?.error) {
          failingNames.push(`${suite['@_name'] ?? ''} > ${testcase['@_name'] ?? ''}`);
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

export const runCheckedCommandSchema = z.object({ command: z.enum(['lint', 'test', 'test:integration']) });
export const runCheckedCommandDescription =
  'Run one of this repo\'s own checks: "lint", "test" (the unit suite, with a structured pass/fail summary ' +
  'parsed from a junit.xml report if the run produces one), or "test:integration" (the integration suite — ' +
  'slow, may need credentials the local environment might not have; only run this if the diff clearly touches ' +
  'integration-sensitive code and you have reason to believe it will run). Each runs `npm run <script>` at the ' +
  'repo root, where <script> is this app\'s configured script name for that check (defaults: "lint", "test:ci", ' +
  '"test:integration").';

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
export function createQaExecutors(deps: { repoRoot: string; baseBranch?: string; checkCommands?: Partial<Record<CheckCommand, string>> }) {
  const runCheckedCommandExecute = async ({ command }: z.infer<typeof runCheckedCommandSchema>): Promise<string> => {
    const script = deps.checkCommands?.[command] ?? DEFAULT_SCRIPTS[command];
    const timeoutMs = TIMEOUTS_MS[command];
    try {
      const { stdout, stderr } = await execFileAsync('npm', ['run', script], {
        cwd: deps.repoRoot,
        timeout: timeoutMs,
        maxBuffer: 10_000_000,
      });
      let text = `${script} succeeded.`;
      if (command === 'test') {
        try {
          const junit = await fs.readFile(path.join(deps.repoRoot, 'junit.xml'), 'utf8');
          text += `\n\n${parseJunitSummary(junit)}`;
        } catch {
          text += '\n\n(no junit.xml found to summarize)';
        }
      }
      // A passing run's log is noise the model re-reads on every later step —
      // the pass/fail line (and junit summary) is all it needs.
      return text;
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; killed?: boolean; message?: string };
      const timedOut = e.killed ? ' (TIMED OUT)' : '';
      let text = `${script} failed${timedOut}.`;
      if (command === 'test') {
        try {
          const junit = await fs.readFile(path.join(deps.repoRoot, 'junit.xml'), 'utf8');
          text += `\n\n${parseJunitSummary(junit)}`;
        } catch {
          // no junit.xml — fall through to raw output
        }
      }
      text += `\n\noutput (errors and summary):\n${compactOutput(e.stdout ?? '', e.stderr ?? e.message ?? '')}`;
      return text;
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

export function createQaTools(deps: { repoRoot: string; baseBranch?: string; checkCommands?: Partial<Record<CheckCommand, string>> }) {
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
