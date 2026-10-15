import path from 'node:path';
import { tool } from 'ai';
import { z } from 'zod';
import { mutateSession, getSession } from '../../sessions/session-store.js';
import { GitPreconditionError, stageAndCommit, worktreeFingerprint } from '../../repo/git.js';
import { assertWritable } from './file-tools.js';
import { commitMessageProblem, normalizeCommitMessage } from './git-tools.js';
import { formatFiles } from '../helpers/format/format.js';
import type { HelperContext } from '../helpers/helper.js';
import { checkSucceeded } from '../pre-qa-gate-core.js';
import type { CheckCache } from './qa-tools.js';

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
  'and call it again with the files you changed. Use this instead of git_commit, run_checked_command and a ' +
  'status update at the end of each step.';

export interface FinishStepDeps {
  sessionId: string;
  repoRoot: string;
  // The branch commits go on (the session's, or a team member's).
  branch: () => Promise<string | null>;
  // A team member's owned paths, and its own steps.
  writablePaths?: string[];
  ownSteps?: string[];
  guard?: () => Promise<void>;
  // Where formatter runs are reported (helpers/format).
  helperContext?: HelperContext;
  // run_checked_command's execute, so failures get the runner helper's report.
  runCheck: (command: 'lint' | 'test') => Promise<string>;
  // The run_checked_command results the agent already has (qa-tools.ts).
  checkCache?: CheckCache;
}

/** Whether a run_checked_command report says the script passed. */
export function checkPassed(report: string): boolean {
  return checkSucceeded(report);
}

/** A check's report when it already passed on this code. */
export function alreadyPassed(command: 'lint' | 'test'): string {
  return `${command} succeeded. (It passed on this same code when you ran it, so it wasn't run again.)`;
}

/** The finish_step reply when the checks fail: the commit stands, the step stays open. */
export function checksFailedReply(stepId: string, committed: string, check: 'lint' | 'test', report: string): string {
  return `${committed}. Step "${stepId}" is still in progress: ${check} failed. Fix it and call finish_step again with the files you change.\n\n${report}`;
}

export function createFinishStepExecute(deps: FinishStepDeps) {
  return async ({ stepId, message: given, files }: FinishStepInput): Promise<string> => {
    await deps.guard?.();
    // Everything that can refuse the call is checked before anything changes.
    const { message, note: subjectNote } = normalizeCommitMessage(given);
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

    // The code as the agent last saw it: checks that passed on exactly this
    // aren't run again below. Taken before formatting, which only restyles.
    const fingerprint = deps.checkCache ? await worktreeFingerprint(deps.repoRoot).catch(() => null) : null;

    // 1. Format what still exists (a deleted file is only committed).
    const formatted = await formatFiles(deps.repoRoot, absolute, deps.helperContext);
    if (!formatted.ok) return `Nothing committed: prettier failed (usually a syntax error).\n\n${formatted.output}`;

    // 2. Commit. Nothing new to commit is fine: a second call after a fix
    // that only touched files already committed still runs the checks.
    let committed: string;
    try {
      const rel = absolute.map((f) => path.relative(deps.repoRoot, f));
      const hash = await stageAndCommit(deps.repoRoot, branch, message, rel, deps.writablePaths);
      committed = `Committed ${hash.slice(0, 8)}: ${message.split('\n')[0]}${subjectNote ? ` (${subjectNote})` : ''}`;
    } catch (err) {
      if (!(err instanceof GitPreconditionError) || !/Nothing staged/.test(err.message)) throw err;
      committed = 'Nothing new to commit';
    }

    // 3. Lint, then the unit tests (they'd fail for the same reason otherwise).
    const check = async (command: 'lint' | 'test') =>
      fingerprint && deps.checkCache!.passedOn(command, fingerprint) ? alreadyPassed(command) : deps.runCheck(command);
    const lint = await check('lint');
    if (!checkPassed(lint)) return checksFailedReply(stepId, committed, 'lint', lint);
    const test = await check('test');
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
      `${committed}. Formatted ${formatted.formatted} file(s); lint and tests passed. Step "${stepId}" is done.${nextLine}` +
      (testSummary ? `\n\n${testSummary}` : '')
    );
  };
}

export function createFinishStepTool(deps: FinishStepDeps) {
  return tool({ description: finishStepDescription, inputSchema: finishStepSchema, execute: createFinishStepExecute(deps) });
}
