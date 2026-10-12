import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { tool } from 'ai';
import { z } from 'zod';
import { mutateSession, getSession } from '../../sessions/session-store.js';
import { GitPreconditionError, stageAndCommit } from '../../repo/git.js';
import { assertWritable } from './file-tools.js';
import { commitMessageProblem } from './git-tools.js';
import { compactOutput } from './output-compress.js';

const execFileAsync = promisify(execFile);

// The end of every plan step used to take three to five requests — format,
// commit, lint, test, mark done — each re-reading the whole context. This
// does them in one, in that order, and stops at the first thing that fails.

export const finishStepSchema = z.object({
  stepId: z.string().describe('The checklist step you just finished'),
  message: z
    .string()
    .describe('Conventional commit message, e.g. "feat: add the job store"; subject at most 72 chars, details in a body after a blank line'),
  files: z
    .array(z.string())
    .min(1)
    .describe('Repo-relative paths you wrote, edited or deleted for this step: they are formatted and committed'),
});
export type FinishStepInput = z.infer<typeof finishStepSchema>;

export const finishStepDescription =
  'Finish a checklist step in one call: prettier on `files`, commit them, run lint and the unit tests, and if both ' +
  "pass, mark the step done and the next pending one in progress. It stops at the first thing that fails and says what: a bad commit message or " +
  'prettier error commits nothing; failing checks leave the commit in place and the step in progress, so fix ' +
  'and call it again with the files you changed. Use this instead of run_prettier, git_commit, ' +
  'run_checked_command and a status update at the end of each step.';

export interface FinishStepDeps {
  sessionId: string;
  repoRoot: string;
  // The branch commits go on (the session's, or a team member's).
  branch: () => Promise<string | null>;
  // A team member's owned paths, and its own steps.
  writablePaths?: string[];
  ownSteps?: string[];
  guard?: () => Promise<void>;
  // run_checked_command's execute, so failures get the runner helper's report.
  runCheck: (command: 'lint' | 'test') => Promise<string>;
}

/** Whether a run_checked_command report says the script passed. */
export function checkPassed(report: string): boolean {
  return /\bsucceeded\.$/.test(report.split('\n')[0].trim());
}

/** The finish_step reply when the checks fail: the commit stands, the step stays open. */
export function checksFailedReply(stepId: string, committed: string, check: 'lint' | 'test', report: string): string {
  return `${committed}. Step "${stepId}" is still in progress: ${check} failed. Fix it and call finish_step again with the files you change.\n\n${report}`;
}

export function createFinishStepExecute(deps: FinishStepDeps) {
  return async ({ stepId, message, files }: FinishStepInput): Promise<string> => {
    await deps.guard?.();
    // Everything that can refuse the call is checked before anything changes.
    const problem = commitMessageProblem(message);
    if (problem) throw new Error(`Nothing done: the commit message is invalid — ${problem}. Message was: "${message.split('\n')[0]}"`);
    if (deps.ownSteps && !deps.ownSteps.includes(stepId)) {
      throw new Error(`"${stepId}" isn't one of your steps (${deps.ownSteps.join(', ')}). Nothing done.`);
    }
    const session = await getSession(deps.sessionId);
    if (!deps.ownSteps && !session?.codingPlan?.some((s) => s.id === stepId)) {
      throw new Error(`There is no step "${stepId}" on the checklist. Nothing done.`);
    }
    const branch = await deps.branch();
    if (!branch) throw new Error('There is no branch yet — create it with git_create_branch first. Nothing done.');
    const absolute = files.map((f) => assertWritable(f, deps.repoRoot, deps.writablePaths));

    // 1. Format what still exists (a deleted file is only committed).
    const present = absolute.filter((f) => existsSync(f));
    if (present.length) {
      try {
        await execFileAsync('npx', ['prettier', '--write', '--ignore-unknown', ...present], {
          cwd: deps.repoRoot,
          timeout: 60_000,
          maxBuffer: 2_000_000,
        });
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string; message?: string };
        return `Nothing committed: prettier failed (usually a syntax error).\n\n${compactOutput(e.stdout ?? '', e.stderr ?? e.message ?? '')}`;
      }
    }

    // 2. Commit. Nothing new to commit is fine: a second call after a fix
    // that only touched files already committed still runs the checks.
    let committed: string;
    try {
      const rel = absolute.map((f) => path.relative(deps.repoRoot, f));
      const hash = await stageAndCommit(deps.repoRoot, branch, message, rel, deps.writablePaths);
      committed = `Committed ${hash.slice(0, 8)}: ${message.split('\n')[0]}`;
    } catch (err) {
      if (!(err instanceof GitPreconditionError) || !/Nothing staged/.test(err.message)) throw err;
      committed = 'Nothing new to commit';
    }

    // 3. Lint, then the unit tests (they'd fail for the same reason otherwise).
    const lint = await deps.runCheck('lint');
    if (!checkPassed(lint)) return checksFailedReply(stepId, committed, 'lint', lint);
    const test = await deps.runCheck('test');
    if (!checkPassed(test)) return checksFailedReply(stepId, committed, 'test', test);

    // 4. Done, and the next pending step (a team member's own) is started.
    let next: { id: string; title: string } | null = null;
    await mutateSession(deps.sessionId, (s) => {
      const plan = s.codingPlan ?? [];
      const step = plan.find((x) => x.id === stepId);
      if (step) step.status = 'done';
      const candidates = deps.ownSteps
        ? deps.ownSteps.map((id) => plan.find((x) => x.id === id)).filter((x): x is NonNullable<typeof x> => Boolean(x))
        : plan;
      const after = candidates.slice(candidates.findIndex((x) => x.id === stepId) + 1);
      const upcoming = after.find((x) => x.status === 'pending');
      if (upcoming) {
        upcoming.status = 'in_progress';
        next = { id: upcoming.id, title: upcoming.title };
      }
    });
    const testSummary = test.split('\n').slice(1).join('\n').trim();
    const nextLine = next ? ` Next step "${(next as { id: string }).id}" is now in progress.` : ' No pending steps left.';
    return (
      `${committed}. Formatted ${present.length} file(s); lint and tests passed. Step "${stepId}" is done.${nextLine}` +
      (testSummary ? `\n\n${testSummary}` : '')
    );
  };
}

export function createFinishStepTool(deps: FinishStepDeps) {
  return tool({ description: finishStepDescription, inputSchema: finishStepSchema, execute: createFinishStepExecute(deps) });
}
