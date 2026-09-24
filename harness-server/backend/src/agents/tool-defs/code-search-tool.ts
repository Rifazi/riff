import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tool } from 'ai';
import { z } from 'zod';

const execFileAsync = promisify(execFile);

export const searchCodeSchema = z.object({
  query: z.string().describe('Pattern to search for, e.g. "ingest.*invoice" or a literal string'),
  glob: z.string().optional().describe('Optional pathspec to narrow the search, e.g. "src/global/adapters/primary/**"'),
});
export const searchCodeDescription =
  'Search src/ and infra/ for a keyword or pattern (git grep, case-insensitive, basic regex). ' +
  'Returns matching file:line and the line text only — not full file contents. Use this to check ' +
  'whether something similar already exists before proposing new code.';

/**
 * Read-only, match-only code search (file:line, not full file contents) —
 * used for grounding against existing conventions without turning a
 * read-limited agent role into a de facto full-file reader.
 */
export function createSearchCodeExecute(deps: { repoRoot: string }) {
  return async ({ query, glob }: z.infer<typeof searchCodeSchema>): Promise<string> => {
    const args = ['grep', '-n', '-I', '-i', '--max-count=3', query, '--', 'src', 'infra'];
    if (glob) args.push(glob);
    try {
      const { stdout } = await execFileAsync('git', args, {
        cwd: deps.repoRoot,
        maxBuffer: 2_000_000,
      });
      const lines = stdout.trim().split('\n').slice(0, 100);
      return lines.join('\n') || 'No matches.';
    } catch (err: unknown) {
      const e = err as { code?: number; stderr?: string };
      if (e.code === 1) {
        return `No matches for "${query}".`;
      }
      throw new Error(`git grep failed: ${e.stderr ?? String(err)}`);
    }
  };
}

export function createSearchCodeTool(deps: { repoRoot: string }) {
  return tool({
    description: searchCodeDescription,
    inputSchema: searchCodeSchema,
    execute: createSearchCodeExecute(deps),
  });
}
