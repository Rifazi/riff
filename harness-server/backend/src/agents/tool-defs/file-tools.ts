import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tool } from 'ai';
import { z } from 'zod';
import { assertPathAllowed, PathNotAllowedError } from '../../repo/guardrails.js';
import { isGeneratedThemePath } from '../../themes/apply-theme.js';
import { outlineText } from './outline-tool.js';
import { ReadMemo } from './read-memo.js';
import { inFixScope } from '../fix-scope.js';
import { symbolRanges } from './symbol-range.js';

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
// How much outline a `symbol` that isn't found comes back with.
const SYMBOL_MISS_OUTLINE_CHARS = 3_000;

export const readFileSchema = z.object({
  path: z.string().describe('Repo-relative path, e.g. src/global/adapters/primary/foo/foo.ts'),
  offset: z.number().int().min(1).optional().describe('1-indexed line number to start reading from, for a large file'),
  limit: z.number().int().min(1).optional().describe(`Max lines to read starting at offset (default ${DEFAULT_LINE_LIMIT})`),
  symbol: z
    .string()
    .optional()
    .describe(
      'Read just this declaration instead of a line range: a function, class, method, type, const, object key or ' +
        'describe/it name ("Class.method" or "OBJ.key" to pick one), or a markdown heading. Ignores offset/limit.'
    ),
});
export const readFileDescription =
  `Read a repo file (not .env, .git/, node_modules/). Returns up to ${DEFAULT_LINE_LIMIT} lines; page with offset/limit. ` +
  'Every read stays in your context, so for a large file read just the part you need: pass `symbol` when you know ' +
  'its name (one call instead of outline_file or search_code and then a read), else find the range with ' +
  "outline_file or search_code. Don't re-read a file you just wrote or edited — those tools report what changed.";

const CODE_STYLE_RULES =
  'Code you write has no comments (only ones a tool needs, like a lint-disable directive) and stays in small, ' +
  'single-purpose files: where a coherent part can stand on its own, give it its own file.';

export const writeFileSchema = z.object({
  path: z.string().describe('Repo-relative path, e.g. src/global/schemas/acme-inventory.schema.json'),
  content: z.string(),
});
export const writeFileDescription =
  'Create a repo file, or replace most of an existing one. To change part of a file, use edit_file — rewriting ' +
  'a whole file costs far more. ' +
  CODE_STYLE_RULES;

export const editFileSchema = z.object({
  path: z.string(),
  oldText: z.string().optional(),
  newText: z.string().optional(),
  edits: z
    .array(z.object({ oldText: z.string(), newText: z.string() }))
    .optional()
    .describe('Several replacements in this file, applied in order in one call, instead of oldText/newText'),
});
export const editFileDescription =
  'Replace an exact, unique occurrence of oldText with newText in an existing file anywhere in the repo (same ' +
  'scope as write_file). To make several changes to one file, pass them all as `edits` in one call — applied in ' +
  'order, all or nothing. Fails if an oldText is not found or occurs more than once, and then shows the file\'s ' +
  'current text where it was closest, so retry from that rather than re-reading. On success it returns the line ' +
  "ranges the new text occupies and the lines around them; the file then matches what you sent, so don't re-read " +
  'it to check. ' +
  CODE_STYLE_RULES;

export const deleteFileSchema = z.object({
  path: z.string().describe('Repo-relative path of the file to delete, e.g. src/utils/legacy-helper.ts'),
});
export const deleteFileDescription =
  'Delete a file from the repo. Subject to the same path restrictions as write_file — no .env, .git/, ' +
  'node_modules/, or theme-generated files. The file must exist. Use git_commit afterwards to record the deletion.';

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
  /** Optional compressor applied to large full-file reads before they enter the agent's context. */
  compress?: (filePath: string, content: string) => Promise<string>;
  /**
   * Told of every read the agent makes, with the text read (before any
   * compression) and the whole file's sha1: the research helper's redo
   * check and the read memory (helpers/memory/).
   */
  onRead?: (filePath: string, read: { text: string; fileHash: string }) => void;
  /** Told of every write_file and edit_file, with the whole file as it now is: the read memory files it as read. */
  onWrite?: (filePath: string, content: string) => void;
  /** Shared with the agent's other read tools and cleared on compaction; a fresh one when unset. */
  readMemo?: ReadMemo;
  /** Runs before every write and throws to refuse it (the lead's pending split decision). */
  guard?: () => Promise<void>;
  /**
   * During a QA fix: the files the findings named (agents/fix-scope.ts).
   * Writes elsewhere are refused until widen_fix_scope adds the path. Null =
   * no fence.
   */
  fixScope?: () => Promise<string[] | null>;
}

async function assertInFixScope(requestedPath: string, repoRoot: string, absolute: string, fixScope?: () => Promise<string[] | null>): Promise<void> {
  const scope = await fixScope?.();
  if (!scope) return;
  const rel = path.relative(repoRoot, absolute).replace(/\\/g, '/');
  if (inFixScope(rel, scope)) return;
  throw new PathNotAllowedError(
    `${requestedPath} isn't one of the files QA's findings named (${scope.join(', ')}), or a test next to one. Fix ` +
      "what QA found in those. If the fix genuinely needs this file, call widen_fix_scope({ paths, reason }) first; QA sees the reason.",
  );
}

export function createFileExecutors(deps: FileToolDeps) {
  // A repeat of an unchanged read gets a note instead of the text — see ReadMemo.
  const readMemo = deps.readMemo ?? new ReadMemo();

  const readFileExecute = async (requested: z.infer<typeof readFileSchema>): Promise<string> => {
    const { args, header } = requested.symbol ? await symbolArgs(requested) : { args: requested, header: '' };
    const { text: paged, fileHash } = await readFileText(args);
    const raw = header + paged;
    deps.onRead?.(args.path, { text: paged, fileHash });
    // Compress full-file reads (no offset/limit) — these are exploration reads.
    // Ranged reads (offset or limit specified) are left verbatim: the agent is
    // pinpointing text it's about to edit and needs it exact.
    const result =
      deps.compress && args.offset === undefined && args.limit === undefined
        ? await deps.compress(args.path, raw)
        : raw;
    if (readMemo.isRepeat(`file\u0000${args.path}:${args.offset ?? ''}:${args.limit ?? ''}`, result)) {
      return (
        `[${args.path} is unchanged since you last read it in this conversation — use that copy. ` +
        'If it is no longer in your context, make the same read_file call again to get the text.]'
      );
    }
    return result;
  };

  // A `symbol` read as the line range it spans, with a header saying what matched.
  const symbolArgs = async (requested: z.infer<typeof readFileSchema>) => {
    const absolute = assertPathAllowed(requested.path, ['.'], deps.repoRoot);
    const content = await fs.readFile(absolute, 'utf8');
    const ranges = symbolRanges(content, requested.path, requested.symbol!);
    if (ranges.length === 0) {
      const outline = outlineText(content, requested.path).join('\n');
      const shown = outline.length > SYMBOL_MISS_OUTLINE_CHARS ? `${outline.slice(0, outline.lastIndexOf('\n', SYMBOL_MISS_OUTLINE_CHARS))}\n[…]` : outline;
      throw new Error(
        `No declaration named "${requested.symbol}" in ${requested.path}.` +
          (shown ? ` Its outline (line ranges for read_file offset/limit):\n${shown}` : ' Read it by line range instead.')
      );
    }
    const [first, ...others] = ranges;
    const also = others.length ? ` Also declared at lines ${others.slice(0, 5).map((r) => `${r.start}-${r.end}`).join(', ')}.` : '';
    return {
      args: { path: requested.path, offset: first.start, limit: first.end - first.start + 1 },
      header: `[${first.label}: lines ${first.start}-${first.end}.${also}]\n`,
    };
  };

  const readFileText = async (args: z.infer<typeof readFileSchema>): Promise<{ text: string; fileHash: string }> => {
    const absolute = assertPathAllowed(args.path, ['.'], deps.repoRoot);
    const content = await fs.readFile(absolute, 'utf8');
    return { text: pageOf(content, args), fileHash: createHash('sha1').update(content).digest('hex') };
  };

  const pageOf = (content: string, { offset, limit }: z.infer<typeof readFileSchema>): string => {
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
    await deps.guard?.();
    const absolute = assertWritable(requestedPath, deps.repoRoot, deps.writablePaths);
    await assertInFixScope(requestedPath, deps.repoRoot, absolute, deps.fixScope);
    const existed = await fs
      .stat(absolute)
      .then(() => true)
      .catch(() => false);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content, 'utf8');
    deps.onWrite?.(requestedPath, content);
    const lineCount = content.split('\n').length;
    return existed
      ? `Wrote ${requestedPath} (${lineCount} lines; replaced the existing file — for partial changes to existing files, edit_file is much cheaper)`
      : `Wrote ${requestedPath} (${lineCount} lines)`;
  };

  const deleteFileExecute = async ({ path: requestedPath }: z.infer<typeof deleteFileSchema>): Promise<string> => {
    await deps.guard?.();
    const absolute = assertWritable(requestedPath, deps.repoRoot, deps.writablePaths);
    await assertInFixScope(requestedPath, deps.repoRoot, absolute, deps.fixScope);
    await fs.unlink(absolute);
    return `Deleted ${requestedPath}`;
  };

  const editFileExecute = async ({ path: requestedPath, oldText, newText, edits }: z.infer<typeof editFileSchema>): Promise<string> => {
    await deps.guard?.();
    const absolute = assertWritable(requestedPath, deps.repoRoot, deps.writablePaths);
    await assertInFixScope(requestedPath, deps.repoRoot, absolute, deps.fixScope);
    const replacements = [...(oldText !== undefined ? [{ oldText, newText: newText ?? '' }] : []), ...(edits ?? [])];
    if (replacements.length === 0) throw new Error('Pass oldText and newText, or edits.');
    // All or nothing: every replacement is checked against the text as the
    // earlier ones left it, and the file is only written if they all apply.
    let content = await fs.readFile(absolute, 'utf8');
    const ranges: string[] = [];
    const spans: [number, number][] = [];
    for (const [i, edit] of replacements.entries()) {
      const label = replacements.length > 1 ? `edit ${i + 1}: ` : '';
      const occurrences = content.split(edit.oldText).length - 1;
      if (occurrences === 0) {
        const near = nearestText(content, edit.oldText);
        throw new Error(`${label}oldText not found in ${requestedPath}. Nothing was changed.${near ? `\n\n${near}` : ''}`);
      }
      if (occurrences > 1) {
        throw new Error(`${label}oldText occurs ${occurrences} times in ${requestedPath} — must be unique. Nothing was changed.`);
      }
      const firstLine = content.slice(0, content.indexOf(edit.oldText)).split('\n').length;
      content = content.replace(edit.oldText, () => edit.newText);
      const lastLine = firstLine + edit.newText.split('\n').length - 1;
      ranges.push(edit.newText ? `lines ${firstLine}-${lastLine}` : `removed at line ${firstLine}`);
      spans.push([firstLine, edit.newText ? lastLine : firstLine - 1]);
    }
    await fs.writeFile(absolute, content, 'utf8');
    deps.onWrite?.(requestedPath, content);
    const around = surroundingText(content, spans);
    return `Edited ${requestedPath} (${ranges.join(', ')} of ${content.split('\n').length})${around ? `\n\n${around}` : ''}`;
  };

  return { readFileExecute, writeFileExecute, editFileExecute, deleteFileExecute };
}

// Lines shown either side of an edit, and the cap on what edit_file adds to
// its reply. 227 reads in the Oct 2026 sessions came straight before a
// further edit of a file the agent had just edited: it needed the exact
// text next to its change for the next oldText.
const EDIT_CONTEXT_LINES = 3;
const EDIT_CONTEXT_CHARS = 1_500;
const NEAREST_CHARS = 2_000;

/**
 * The lines either side of each edited span (1-indexed, inclusive; an
 * empty span is a removal before that line), with the new text itself
 * elided since the caller just sent it. Spans are given in edit order, and
 * line numbers are those after every edit, so only the last edit's are
 * exact when edits shift each other: it's context, not a map.
 */
export function surroundingText(content: string, spans: [number, number][]): string {
  const lines = content.split('\n');
  const blocks: string[] = [];
  let total = 0;
  for (const [first, last] of spans) {
    const before = lines.slice(Math.max(0, first - 1 - EDIT_CONTEXT_LINES), first - 1);
    const after = lines.slice(Math.max(last, first - 1), last + EDIT_CONTEXT_LINES);
    const middle = last >= first ? `… your new text, lines ${first}-${last} …` : `… removed here …`;
    const block = [...before, middle, ...after].join('\n');
    if (total + block.length > EDIT_CONTEXT_CHARS) break;
    total += block.length;
    blocks.push(block);
  }
  return blocks.length ? `Around it now:\n\`\`\`\n${blocks.join('\n\`\`\`\n\`\`\`\n')}\n\`\`\`` : '';
}

/**
 * Where a missing oldText is closest in the file: the lines around the
 * first line of it that still occurs (trimmed), else around its longest
 * line. Null when none of its lines is in the file.
 */
export function nearestText(content: string, oldText: string): string | null {
  const lines = content.split('\n');
  const wanted = oldText.split('\n').map((l) => l.trim()).filter((l) => l.length >= 4);
  const candidates = [...wanted, ...[...wanted].sort((a, b) => b.length - a.length)];
  for (const target of candidates) {
    const at = lines.findIndex((l) => l.trim() === target);
    if (at < 0) continue;
    const offsetInOld = oldText.split('\n').findIndex((l) => l.trim() === target);
    const start = Math.max(0, at - Math.max(0, offsetInOld) - 2);
    let end = Math.min(lines.length, start + oldText.split('\n').length + 4);
    let text = lines.slice(start, end).join('\n');
    while (text.length > NEAREST_CHARS && end > start + 1) {
      end -= 1;
      text = lines.slice(start, end).join('\n');
    }
    return `Current text at lines ${start + 1}-${end}:\n\`\`\`\n${text}\n\`\`\``;
  }
  return null;
}

export function createFileTools(deps: FileToolDeps) {
  const { readFileExecute, writeFileExecute, editFileExecute, deleteFileExecute } = createFileExecutors(deps);
  return {
    readFileTool: tool({ description: readFileDescription, inputSchema: readFileSchema, execute: readFileExecute }),
    writeFileTool: tool({ description: writeFileDescription, inputSchema: writeFileSchema, execute: writeFileExecute }),
    editFileTool: tool({ description: editFileDescription, inputSchema: editFileSchema, execute: editFileExecute }),
    deleteFileTool: tool({ description: deleteFileDescription, inputSchema: deleteFileSchema, execute: deleteFileExecute }),
  };
}
