import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { compactOutput } from '../../tool-defs/output-compress.js';
import { reportHelperRun, type HelperContext, type HelperRunStats } from '../helper.js';

const execFileAsync = promisify(execFile);

// Formatting, done for the agent instead of by it. A `run_prettier` call
// returned a one-line answer but cost a whole paid request, re-reading the
// entire context: 154 of them in the usage log, next to 150 `git_commit`s it
// always preceded. So `git_commit` and `finish_step` format the files they
// commit, and agents no longer have a formatting tool. Each run is reported
// as helper `format`. Its saving is counted, not estimated: it saves one paid
// request per commit, and that request's size is the agent's whole context,
// which can't be seen from here.

export type FormatResult = { ok: true; formatted: number } | { ok: false; output: string };

/**
 * `prettier --write --ignore-unknown` on the given absolute paths that still
 * exist (a deleted file is only committed). Prettier itself skips anything
 * in the repo's .prettierignore and files it has no parser for. A failure
 * is almost always a syntax error in one of the files.
 */
export async function formatFiles(
  repoRoot: string,
  absolutePaths: string[],
  context?: HelperContext,
): Promise<FormatResult> {
  const present = absolutePaths.filter((f) => existsSync(f));
  if (!present.length) return { ok: true, formatted: 0 };
  const result = await runPrettier(repoRoot, present);
  const run = formatRunReport(present.length, result);
  await reportHelperRun(context, run.stats, run.summary);
  return result;
}

/** What one formatter run reports: files given, files formatted (none when prettier failed). */
export function formatRunReport(given: number, result: FormatResult): { stats: HelperRunStats; summary: string } {
  const formatted = result.ok ? result.formatted : 0;
  return {
    stats: { helper: 'format', model: 'prettier', tasks: given, useful: formatted, savedTokens: null },
    summary: result.ok
      ? `Formatter: prettier formatted ${formatted} file${formatted === 1 ? '' : 's'}`
      : `Formatter: prettier failed on ${given} file${given === 1 ? '' : 's'}, nothing was committed`,
  };
}

async function runPrettier(repoRoot: string, present: string[]): Promise<FormatResult> {
  try {
    await execFileAsync('npx', ['prettier', '--write', '--ignore-unknown', ...present], {
      cwd: repoRoot,
      timeout: 60_000,
      maxBuffer: 2_000_000,
    });
    return { ok: true, formatted: present.length };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, output: compactOutput(e.stdout ?? '', e.stderr ?? e.message ?? '') };
  }
}
