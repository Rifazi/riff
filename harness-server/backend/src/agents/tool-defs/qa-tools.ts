import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { tool } from 'ai';
import { z } from 'zod';
import { diffAgainstBase, diffStatAgainstBase } from '../../repo/git.js';

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

export const getDiffSchema = z.object({ branchName: z.string() });
export const getDiffDescription =
  'Get the full diff and stat summary between master and this session\'s branch — the actual change set to ' +
  'review, not the coding agent\'s self-report.';

/**
 * Closed enum, not a free-form command string — the actual safety mechanism.
 * Runs via execFile (argv array), never shell interpolation. A failing
 * lint/test run is informative content the QA agent needs to see and reason
 * about, not a tool-execution error, so this always returns normally
 * (pass/fail is embedded in the text) rather than throwing.
 */
export function createQaExecutors(deps: { repoRoot: string; checkCommands?: Partial<Record<CheckCommand, string>> }) {
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
      text += `\n\nraw output (tail):\n${stdout.slice(-3000)}\n${stderr.slice(-1000)}`;
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
      text += `\n\nraw output (tail):\n${(e.stdout ?? '').slice(-3000)}\n${(e.stderr ?? e.message ?? '').slice(-2000)}`;
      return text;
    }
  };

  const getDiffExecute = async ({ branchName }: z.infer<typeof getDiffSchema>): Promise<string> => {
    const [diff, stat] = await Promise.all([
      diffAgainstBase(deps.repoRoot, branchName),
      diffStatAgainstBase(deps.repoRoot, branchName),
    ]);
    return `${stat}\n\n${diff}`.slice(0, 60_000);
  };

  return { runCheckedCommandExecute, getDiffExecute };
}

export function createQaTools(deps: { repoRoot: string; checkCommands?: Partial<Record<CheckCommand, string>> }) {
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
