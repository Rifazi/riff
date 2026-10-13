import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tool } from 'ai';
import { z } from 'zod';
import { groupGrepOutput, NOISE_PATHSPECS } from './output-compress.js';

const execFileAsync = promisify(execFile);

export const searchCodeSchema = z.object({
  query: z.string().describe('Pattern to search for, e.g. "ingest.*invoice", "getImsPool|getDpdPool" or a literal string'),
  glob: z
    .string()
    .optional()
    .describe(
      'Optional pathspec to narrow the search, e.g. "src/global/adapters/primary/**". "." searches the whole repo even when ' +
        'the search would otherwise start in your current focus (see the tool description)'
    ),
  context: z
    .number()
    .int()
    .min(0)
    .max(3)
    .optional()
    .describe('Lines of surrounding code to show around each match (0-3, default 0) — enough to see a call site without reading the file'),
});
export const searchCodeDescription =
  'Search the repo\'s files (committed or not, .gitignore aside) for a keyword or pattern (git grep, case-insensitive, extended regex so `a|b` ' +
  'works; a pattern that isn\'t valid regex is searched literally; lockfiles, snapshots and build output are skipped). ' +
  'Returns matching lines grouped by file (line number and text only — not full file contents): up to 3 matches per ' +
  'file, or 10 when `glob` narrows the search. When no line matches, it lists files whose path matches ' +
  'instead, so it also finds files by name (e.g. "vitest.config"). Use this to check whether something similar ' +
  'already exists before proposing new code, and to find the line range to read_file. In an app that follows an ' +
  'architecture, a search without `glob` looks in the folders you are working in first (the result says which) and ' +
  'only searches the whole repo when nothing matches there. A pattern that matches every line (".") lists files instead ' +
  'of returning their lines; in an app that follows an architecture it returns the domains\' generated Files sections.';

/**
 * Where a search without a glob looks first: e.g. the domains a coding step
 * names. `label` says why, in the result. null or no paths = the whole repo.
 */
export type SearchFocus = () => Promise<{ label: string; paths: string[] } | null>;

/**
 * How a pattern that matches every line is answered: e.g. the Files sections
 * of the domains under `glob`. null = list the files plainly.
 */
export type SearchListing = (glob: string | undefined) => Promise<string | null>;

export interface SearchCodeDeps {
  repoRoot: string;
  focus?: SearchFocus;
  listing?: SearchListing;
}

const PLAIN_LIST_LIMIT = 80;

/** A pattern that matches every line ("", ".", ".*", "^", "^.*$"): the agent is listing files, not searching. */
export function isListAllQuery(query: string): boolean {
  return /^\^?(\.[*+]?)?\$?$/.test(query.trim());
}

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
export function createSearchCodeExecute(deps: SearchCodeDeps) {
  const pathspec = (paths: string[]) => ['--', ...paths, ...NOISE_PATHSPECS];

  // Exit code 1 is "no matches"; 128 with `-E` is a pattern that isn't
  // valid extended regex ("foo(", "a{"), retried as a literal string.
  const grep = async (mode: '-E' | '-F', query: string, paths: string[], narrowed: boolean, context: number | undefined): Promise<string> => {
    // --untracked: an agent's new files aren't committed yet, and it searches them too.
    const args = ['grep', '--untracked', '-n', '-z', '-I', '-i', mode, `--max-count=${narrowed ? 10 : 3}`];
    if (context) args.push(`-C${context}`);
    args.push('-e', query, ...pathspec(paths));
    try {
      const { stdout } = await execFileAsync('git', args, { cwd: deps.repoRoot, maxBuffer: 2_000_000 });
      return stdout;
    } catch (err: unknown) {
      const e = err as { code?: number; stderr?: string };
      if (e.code === 1) return '';
      if (e.code === 128 && mode === '-E') return grep('-F', query, paths, narrowed, context);
      throw new Error(`git grep failed: ${e.stderr ?? String(err)}`);
    }
  };

  const listFiles = async (glob: string | undefined): Promise<string> => {
    const listed = await deps.listing?.(glob).catch(() => null);
    if (listed) return listed;
    const { stdout } = await execFileAsync('git', ['ls-files', '-z', '-co', '--exclude-standard', '--', glob ?? '.'], { cwd: deps.repoRoot, maxBuffer: 20_000_000 });
    const files = stdout.split('\0').filter(Boolean);
    if (!files.length) return `No files under "${glob ?? '.'}".`;
    const more = files.length > PLAIN_LIST_LIMIT ? `\n…and ${files.length - PLAIN_LIST_LIMIT} more: narrow the glob.` : '';
    return `A pattern that matches every line only lists files. ${files.length} under "${glob ?? '.'}":\n${files.slice(0, PLAIN_LIST_LIMIT).join('\n')}${more}`;
  };

  return async ({ query, glob, context }: z.infer<typeof searchCodeSchema>): Promise<string> => {
    if (isListAllQuery(query)) return listFiles(glob);
    let note = '';
    if (!glob && deps.focus) {
      const focus = await deps.focus().catch(() => null);
      if (focus?.paths.length) {
        const where = focus.paths.join(', ');
        const hits = await grep('-E', query, focus.paths, true, context);
        if (hits) return `Searched ${where} (${focus.label}). Pass glob: "." to search the whole repo.\n${groupGrepOutput(hits) || 'No matches.'}`;
        note = `Nothing in ${where} (${focus.label}); searched the whole repo.\n`;
      }
    }
    const stdout = await grep('-E', query, [glob ?? '.'], Boolean(glob), context);
    if (stdout) return note + (groupGrepOutput(stdout) || 'No matches.');

    // No noise excludes here: ls-files matches nothing at all when a
    // wildcard pathspec ("backend/*") is combined with an exclude one.
    const { stdout: files } = await execFileAsync('git', ['ls-files', '-z', '-co', '--exclude-standard', '--', glob ?? '.'], {
      cwd: deps.repoRoot,
      maxBuffer: 20_000_000,
    });
    const paths = matchPaths(files.split('\0').filter(Boolean), query);
    if (!paths.length) return `No matches for "${query}".`;
    return `${note}No line matches "${query}", but these files' paths do:\n${paths.join('\n')}`;
  };
}

export function createSearchCodeTool(deps: SearchCodeDeps) {
  return tool({
    description: searchCodeDescription,
    inputSchema: searchCodeSchema,
    execute: createSearchCodeExecute(deps),
  });
}
