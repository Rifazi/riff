import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tool } from 'ai';
import { z } from 'zod';
import { assertPathAllowed } from '../../repo/guardrails.js';
import { WRITE_ALLOWED_ROOTS } from './file-tools.js';

const execFileAsync = promisify(execFile);

export const runPrettierSchema = z.object({
  files: z
    .array(z.string())
    .min(1)
    .describe('Repo-relative paths to format — only the files you just wrote or edited this step, e.g. ["src/global/schemas/acme.schema.json"]'),
});
export const runPrettierDescription =
  "Run prettier --write on exactly the files you list, formatting them in place. Only ever pass the files you " +
  "just wrote or edited this step — never the whole repo or files from other steps, which would pull unrelated " +
  "formatting changes into your diff. Call this before git_commit so the commit already contains clean output, " +
  "in addition to (not instead of) run_checked_command \"lint\".";

/**
 * Deliberately narrower than the repo's own `npm run prettier:write` (which
 * formats the entire src/ tree) — path-scoped the same way write_file and
 * edit_file are, via the same assertPathAllowed guardrail, so a step's
 * diff can never balloon with unrelated pre-existing formatting drift
 * elsewhere in the repo.
 */
export function createRunPrettierExecute(deps: { repoRoot: string }) {
  return async ({ files }: z.infer<typeof runPrettierSchema>): Promise<string> => {
    const absolutePaths = files.map((f) => assertPathAllowed(f, WRITE_ALLOWED_ROOTS, deps.repoRoot));

    try {
      const { stdout, stderr } = await execFileAsync('npx', ['prettier', '--write', ...absolutePaths], {
        cwd: deps.repoRoot,
        timeout: 30_000,
        maxBuffer: 2_000_000,
      });
      return `Formatted ${files.length} file(s): ${files.join(', ')}\n\n${stdout}${stderr}`.trim();
    } catch (err: unknown) {
      // Not a guardrail violation (that throws above) — prettier itself
      // failed, almost always a syntax error in one of the files. That's
      // information for the model to react to, not a broken tool call.
      const e = err as { stdout?: string; stderr?: string; message?: string };
      return `prettier failed on one or more files.\n\n${(e.stdout ?? '').slice(-2000)}\n${(e.stderr ?? e.message ?? '').slice(-2000)}`;
    }
  };
}

export function createRunPrettierTool(deps: { repoRoot: string }) {
  return tool({
    description: runPrettierDescription,
    inputSchema: runPrettierSchema,
    execute: createRunPrettierExecute(deps),
  });
}
