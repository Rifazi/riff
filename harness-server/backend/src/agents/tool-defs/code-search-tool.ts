import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tool } from 'ai';
import { z } from 'zod';
import { groupGrepOutput, NOISE_PATHSPECS } from './output-compress.js';

const execFileAsync = promisify(execFile);

export const searchCodeSchema = z.object({
  query: z.string().describe('Pattern to search for, e.g. "ingest.*invoice", "getImsPool|getDpdPool" or a literal string'),
  glob: z.string().optional().describe('Optional pathspec to narrow the search, e.g. "src/global/adapters/primary/**"'),
  context: z
    .number()
    .int()
    .min(0)
    .max(3)
    .optional()
    .describe('Lines of surrounding code to show around each match (0-3, default 0) — enough to see a call site without reading the file'),
});
export const searchCodeDescription =
  'Search the repo\'s tracked files for a keyword or pattern (git grep, case-insensitive, extended regex so `a|b` ' +
  'works; a pattern that isn\'t valid regex is searched literally; lockfiles, snapshots and build output are skipped). ' +
  'Returns matching lines grouped by file (line number and text only — not full file contents): up to 3 matches per ' +
  'file, or 10 when `glob` narrows the search. When no line matches, it lists tracked files whose path matches ' +
  'instead, so it also finds files by name (e.g. "vitest.config"). Use this to check whether something similar ' +
  'already exists before proposing new code, and to find the line range to read_file.';

const PATH_MATCH_LIMIT = 15;

/**
 * Tracked paths matching `query` (as a case-insensitive regex, else as a
 * literal), for a search whose contents found nothing: agents look for
 * files by name with search_code too, and a miss there used to send them
 * on several more searches.
 */
export function matchPaths(paths: string[], query: string, limit = PATH_MATCH_LIMIT): string[] {
  let test: (p: string) => boolean;
  try {
    const re = new RegExp(query, 'i');
    test = (p) => re.test(p);
  } catch {
    const needle = query.toLowerCase();
    test = (p) => p.toLowerCase().includes(needle);
  }
  return paths.filter(test).slice(0, limit);
}

/**
 * Read-only, match-only code search (file:line, not full file contents) —
 * used for grounding against existing conventions without turning a
 * read-limited agent role into a de facto full-file reader.
 */
export function createSearchCodeExecute(deps: { repoRoot: string }) {
  const pathspec = (glob?: string) => ['--', glob ?? '.', ...NOISE_PATHSPECS];

  // Exit code 1 is "no matches"; 128 with `-E` is a pattern that isn't
  // valid extended regex ("foo(", "a{"), retried as a literal string.
  const grep = async (mode: '-E' | '-F', query: string, glob: string | undefined, context: number | undefined) => {
    const args = ['grep', '-n', '-z', '-I', '-i', mode, `--max-count=${glob ? 10 : 3}`];
    if (context) args.push(`-C${context}`);
    args.push('-e', query, ...pathspec(glob));
    try {
      const { stdout } = await execFileAsync('git', args, { cwd: deps.repoRoot, maxBuffer: 2_000_000 });
      return stdout;
    } catch (err: unknown) {
      const e = err as { code?: number; stderr?: string };
      if (e.code === 1) return '';
      if (e.code === 128 && mode === '-E') return grep('-F', query, glob, context);
      throw new Error(`git grep failed: ${e.stderr ?? String(err)}`);
    }
  };

  return async ({ query, glob, context }: z.infer<typeof searchCodeSchema>): Promise<string> => {
    const stdout = await grep('-E', query, glob, context);
    if (stdout) return groupGrepOutput(stdout) || 'No matches.';

    // No noise excludes here: ls-files matches nothing at all when a
    // wildcard pathspec ("backend/*") is combined with an exclude one.
    const { stdout: files } = await execFileAsync('git', ['ls-files', '-z', '--', glob ?? '.'], {
      cwd: deps.repoRoot,
      maxBuffer: 20_000_000,
    });
    const paths = matchPaths(files.split('\0').filter(Boolean), query);
    if (!paths.length) return `No matches for "${query}".`;
    return `No line matches "${query}", but these tracked files' paths do:\n${paths.join('\n')}`;
  };
}

export function createSearchCodeTool(deps: { repoRoot: string }) {
  return tool({
    description: searchCodeDescription,
    inputSchema: searchCodeSchema,
    execute: createSearchCodeExecute(deps),
  });
}
