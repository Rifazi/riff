import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tool } from 'ai';
import { z } from 'zod';
import { assertWritable, type FileToolDeps } from './file-tools.js';
import { compactOutput } from './output-compress.js';

const execFileAsync = promisify(execFile);

export const runPrettierSchema = z.object({
  files: z
    .array(z.string())
    .min(1)
    .describe('Repo-relative paths to format — only the files you just wrote or edited this step, e.g. ["src/global/schemas/acme.schema.json"]'),
});
export const runPrettierDescription =
  "prettier --write the files you list — only the ones you wrote or edited this step, so unrelated formatting " +
  "stays out of the diff. Run it before git_commit.";

/**
 * Deliberately narrower than the repo's own `npm run prettier:write` (which
 * formats the entire src/ tree) — path-scoped the same way write_file and
 * edit_file are, via the same assertPathAllowed guardrail, so a step's
 * diff can never balloon with unrelated pre-existing formatting drift
 * elsewhere in the repo.
 */
export function createRunPrettierExecute(deps: FileToolDeps) {
  return async ({ files }: z.infer<typeof runPrettierSchema>): Promise<string> => {
    const absolutePaths = files.map((f) => assertWritable(f, deps.repoRoot, deps.writablePaths));

    try {
      await execFileAsync('npx', ['prettier', '--write', ...absolutePaths], {
        cwd: deps.repoRoot,
        timeout: 30_000,
        maxBuffer: 2_000_000,
      });
      return `Formatted ${files.length} file(s): ${files.join(', ')}`;
    } catch (err: unknown) {
      // Not a guardrail violation (that throws above) — prettier itself
      // failed, almost always a syntax error in one of the files. That's
      // information for the model to react to, not a broken tool call.
      const e = err as { stdout?: string; stderr?: string; message?: string };
      return `prettier failed on one or more files.\n\n${compactOutput(e.stdout ?? '', e.stderr ?? e.message ?? '')}`;
    }
  };
}

export function createRunPrettierTool(deps: FileToolDeps) {
  return tool({
    description: runPrettierDescription,
    inputSchema: runPrettierSchema,
    execute: createRunPrettierExecute(deps),
  });
}
