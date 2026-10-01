import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tool } from 'ai';
import { z } from 'zod';
import { assertPathAllowed, PathNotAllowedError } from '../../repo/guardrails.js';
import { isGeneratedThemePath } from '../../themes/apply-theme.js';

// Same "anything under repoRoot except the always-forbidden paths" scope as
// read_file — target repos aren't all shaped like the original Customer-EDI
// (src/, infra/, docs/, openapi/ at the root); this harness now manages
// multiple apps (see apps/apps.ts) with their own layouts (e.g. backend/,
// frontend/), so a fixed top-level allowlist would block legitimate work in
// any app that doesn't match the legacy shape. assertPathAllowed's internal
// `forbidden` list (.env, .git/, node_modules/, cdk.out/, harness/, etc.)
// still applies regardless.
export const WRITE_ALLOWED_ROOTS = ['.'];

// The Claude Agent SDK's own MCP tool-result handling hard-errors past a
// size cap ("exceeds maximum allowed tokens") and tells the model to retry
// with offset/limit — but that only helps if the tool actually supports
// them. Without this, a large file (a CDK snapshot test, a lockfile, a big
// existing adapter) made the coding/QA agent permanently stuck: told to
// page through the file, with no way to. Truncating proactively here also
// protects the AI-SDK engine (anthropic/openai/google), which has no
// equivalent built-in guard of its own and would otherwise just blow
// straight through context/cost on a huge file.
//
// Every read stays in the conversation and is re-sent on each later step,
// so file reads were most of what coding conversations cost: a page is
// 300 lines and at most READ_CHAR_LIMIT characters (cut at a line break),
// whichever comes first.
const DEFAULT_LINE_LIMIT = 300;
const READ_CHAR_LIMIT = 16_000;

export const readFileSchema = z.object({
  path: z.string().describe('Repo-relative path, e.g. src/global/adapters/primary/foo/foo.ts'),
  offset: z.number().int().min(1).optional().describe('1-indexed line number to start reading from, for a large file'),
  limit: z.number().int().min(1).optional().describe(`Max lines to read starting at offset (default ${DEFAULT_LINE_LIMIT})`),
});
export const readFileDescription =
  'Read a file anywhere in the repo (except .env, .git/, node_modules/, cdk.out/, and the harness\'s own runtime ' +
  `state). Files over ${DEFAULT_LINE_LIMIT} lines are truncated to the first ${DEFAULT_LINE_LIMIT} unless you pass ` +
  `offset and/or limit — use those to page through the rest (e.g. offset: ${DEFAULT_LINE_LIMIT + 1}). Every read stays ` +
  'in your context for the rest of the conversation, so read only what you need: for a large file, outline_file or ' +
  "search_code for the part you need first, then read just that range. Don't re-read a file you just wrote or edited to check it — " +
  'write_file and edit_file report the lines they changed.';

export const writeFileSchema = z.object({
  path: z.string().describe('Repo-relative path, e.g. src/global/schemas/acme-inventory.schema.json'),
  content: z.string(),
});
export const writeFileDescription =
  'Create a new file anywhere in the repo (except .env, .git/, node_modules/, cdk.out/, and the harness\'s own ' +
  'runtime state), or replace most of an existing one. To change part of an existing file, use edit_file ' +
  'instead — rewriting the whole file costs far more.';

export const editFileSchema = z.object({
  path: z.string(),
  oldText: z.string(),
  newText: z.string(),
});
export const editFileDescription =
  'Replace an exact, unique occurrence of oldText with newText in an existing file anywhere in the repo (same ' +
  'scope as write_file). Fails if oldText is not found or occurs more than once — read the file first. On success it ' +
  "returns the line range newText now occupies; the file then matches what you sent, so don't re-read it to check.";

/**
 * For a coding-team member: `writablePaths` are the paths its workstream
 * owns (sessions/plan-doc.ts guarantees no two members' paths overlap), so
 * concurrent members can never write the same file and their branches merge
 * cleanly. Unset for every other agent — anywhere under the repo, as before.
 */
export function assertWritable(requestedPath: string, repoRoot: string, writablePaths?: string[]): string {
  const absolute = assertPathAllowed(requestedPath, WRITE_ALLOWED_ROOTS, repoRoot);
  if (isGeneratedThemePath(repoRoot, path.relative(repoRoot, absolute))) {
    throw new PathNotAllowedError(
      `${requestedPath} is generated from the app's UI theme (theme/theme.json) by Riff. Don't edit it: style your code with ` +
        "the theme's tokens, and if the theme itself needs to change, tell the human to change it in Riff's theme picker."
    );
  }
  if (!writablePaths) return absolute;
  try {
    return assertPathAllowed(requestedPath, writablePaths, repoRoot);
  } catch (err) {
    if (!(err instanceof PathNotAllowedError)) throw err;
    throw new PathNotAllowedError(
      `${requestedPath} isn't in your workstream's owned paths (${writablePaths.join(', ')}). Another team member may ` +
        'own it — leave it alone, and say in your summary what change it would need.'
    );
  }
}

export interface FileToolDeps {
  repoRoot: string;
  writablePaths?: string[];
}

export function createFileExecutors(deps: FileToolDeps) {
  // A read the model repeats with nothing changed is answered with a short
  // note instead of the same text again, since the first copy is still in
  // its context. The same read asked for once more gets the text, so a read
  // that compaction dropped from the context can always be fetched again.
  const notedRepeats = new Map<string, string>();
  const lastReads = new Map<string, string>();

  const readFileExecute = async (args: z.infer<typeof readFileSchema>): Promise<string> => {
    const result = await readFileText(args);
    const key = `${args.path}:${args.offset ?? ''}:${args.limit ?? ''}`;
    const hash = createHash('sha1').update(result).digest('hex');
    if (lastReads.get(key) === hash && notedRepeats.get(key) !== hash) {
      notedRepeats.set(key, hash);
      return (
        `[${args.path} is unchanged since you last read it in this conversation — use that copy. ` +
        'If it is no longer in your context, make the same read_file call again to get the text.]'
      );
    }
    notedRepeats.delete(key);
    lastReads.set(key, hash);
    return result;
  };

  const readFileText = async ({ path: requestedPath, offset, limit }: z.infer<typeof readFileSchema>): Promise<string> => {
    const absolute = assertPathAllowed(requestedPath, ['.'], deps.repoRoot);
    const content = await fs.readFile(absolute, 'utf8');

    const lines = content.split('\n');
    const totalLines = lines.length;
    if (offset === undefined && limit === undefined && totalLines <= DEFAULT_LINE_LIMIT && content.length <= READ_CHAR_LIMIT) {
      return content;
    }

    const start = Math.max(0, (offset ?? 1) - 1);
    let end = Math.min(start + (limit ?? DEFAULT_LINE_LIMIT), totalLines);
    let chars = 0;
    for (let i = start; i < end; i++) {
      chars += lines[i].length + 1;
      if (chars > READ_CHAR_LIMIT && i > start) {
        end = i;
        break;
      }
    }
    let slice = lines.slice(start, end).join('\n');
    // One enormous line (minified code, a data blob) still gets the cap.
    if (slice.length > READ_CHAR_LIMIT) slice = `${slice.slice(0, READ_CHAR_LIMIT)} [… line cut at ${READ_CHAR_LIMIT} chars]`;
    const continuation = end < totalLines ? ` — more remains, pass offset: ${end + 1} to continue` : '';
    return `[lines ${start + 1}-${end} of ${totalLines}${continuation}]\n${slice}`;
  };

  const writeFileExecute = async ({ path: requestedPath, content }: z.infer<typeof writeFileSchema>): Promise<string> => {
    const absolute = assertWritable(requestedPath, deps.repoRoot, deps.writablePaths);
    const existed = await fs
      .stat(absolute)
      .then(() => true)
      .catch(() => false);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content, 'utf8');
    const lineCount = content.split('\n').length;
    return existed
      ? `Wrote ${requestedPath} (${lineCount} lines; replaced the existing file — for partial changes to existing files, edit_file is much cheaper)`
      : `Wrote ${requestedPath} (${lineCount} lines)`;
  };

  const editFileExecute = async ({ path: requestedPath, oldText, newText }: z.infer<typeof editFileSchema>): Promise<string> => {
    const absolute = assertWritable(requestedPath, deps.repoRoot, deps.writablePaths);
    const content = await fs.readFile(absolute, 'utf8');
    const occurrences = content.split(oldText).length - 1;
    if (occurrences === 0) {
      throw new Error(`oldText not found in ${requestedPath}.`);
    }
    if (occurrences > 1) {
      throw new Error(`oldText occurs ${occurrences} times in ${requestedPath} — must be unique.`);
    }
    const updated = content.replace(oldText, newText);
    await fs.writeFile(absolute, updated, 'utf8');
    const firstLine = content.slice(0, content.indexOf(oldText)).split('\n').length;
    const lastLine = firstLine + newText.split('\n').length - 1;
    const range = newText ? `lines ${firstLine}-${lastLine}` : `removed at line ${firstLine}`;
    return `Edited ${requestedPath} (${range} of ${updated.split('\n').length})`;
  };

  return { readFileExecute, writeFileExecute, editFileExecute };
}

export function createFileTools(deps: FileToolDeps) {
  const { readFileExecute, writeFileExecute, editFileExecute } = createFileExecutors(deps);
  return {
    readFileTool: tool({ description: readFileDescription, inputSchema: readFileSchema, execute: readFileExecute }),
    writeFileTool: tool({ description: writeFileDescription, inputSchema: writeFileSchema, execute: writeFileExecute }),
    editFileTool: tool({ description: editFileDescription, inputSchema: editFileSchema, execute: editFileExecute }),
  };
}
