import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tool } from 'ai';
import { z } from 'zod';
import { assertPathAllowed } from '../../repo/guardrails.js';

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
const DEFAULT_LINE_LIMIT = 2000;

export const readFileSchema = z.object({
  path: z.string().describe('Repo-relative path, e.g. src/global/adapters/primary/foo/foo.ts'),
  offset: z.number().int().min(1).optional().describe('1-indexed line number to start reading from, for a large file'),
  limit: z.number().int().min(1).optional().describe(`Max lines to read starting at offset (default ${DEFAULT_LINE_LIMIT})`),
});
export const readFileDescription =
  'Read a file anywhere in the repo (except .env, .git/, node_modules/, cdk.out/, and the harness\'s own runtime ' +
  `state). Files over ${DEFAULT_LINE_LIMIT} lines are truncated to the first ${DEFAULT_LINE_LIMIT} unless you pass ` +
  'offset and/or limit — use those to page through the rest (e.g. offset: 2001) for large generated files like ' +
  'CDK snapshot tests or lockfiles.';

export const writeFileSchema = z.object({
  path: z.string().describe('Repo-relative path, e.g. src/global/schemas/acme-inventory.schema.json'),
  content: z.string(),
});
export const writeFileDescription =
  'Create or overwrite a file anywhere in the repo (except .env, .git/, node_modules/, cdk.out/, and the ' +
  "harness's own runtime state). Use edit_file for small changes to existing files.";

export const editFileSchema = z.object({
  path: z.string(),
  oldText: z.string(),
  newText: z.string(),
});
export const editFileDescription =
  'Replace an exact, unique occurrence of oldText with newText in an existing file anywhere in the repo (same ' +
  'scope as write_file). Fails if oldText is not found or occurs more than once — read the file first.';

export function createFileExecutors(deps: { repoRoot: string }) {
  const readFileExecute = async ({ path: requestedPath, offset, limit }: z.infer<typeof readFileSchema>): Promise<string> => {
    const absolute = assertPathAllowed(requestedPath, ['.'], deps.repoRoot);
    const content = await fs.readFile(absolute, 'utf8');

    if (offset === undefined && limit === undefined) {
      const totalLines = content.split('\n').length;
      if (totalLines <= DEFAULT_LINE_LIMIT) return content;
    }

    const lines = content.split('\n');
    const totalLines = lines.length;
    const start = Math.max(0, (offset ?? 1) - 1);
    const end = Math.min(start + (limit ?? DEFAULT_LINE_LIMIT), totalLines);
    const slice = lines.slice(start, end).join('\n');
    const continuation = end < totalLines ? ` — more remains, pass offset: ${end + 1} to continue` : '';
    return `[lines ${start + 1}-${end} of ${totalLines}${continuation}]\n${slice}`;
  };

  const writeFileExecute = async ({ path: requestedPath, content }: z.infer<typeof writeFileSchema>): Promise<string> => {
    const absolute = assertPathAllowed(requestedPath, WRITE_ALLOWED_ROOTS, deps.repoRoot);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content, 'utf8');
    return `Wrote ${requestedPath}`;
  };

  const editFileExecute = async ({ path: requestedPath, oldText, newText }: z.infer<typeof editFileSchema>): Promise<string> => {
    const absolute = assertPathAllowed(requestedPath, WRITE_ALLOWED_ROOTS, deps.repoRoot);
    const content = await fs.readFile(absolute, 'utf8');
    const occurrences = content.split(oldText).length - 1;
    if (occurrences === 0) {
      throw new Error(`oldText not found in ${requestedPath}.`);
    }
    if (occurrences > 1) {
      throw new Error(`oldText occurs ${occurrences} times in ${requestedPath} — must be unique.`);
    }
    await fs.writeFile(absolute, content.replace(oldText, newText), 'utf8');
    return `Edited ${requestedPath}`;
  };

  return { readFileExecute, writeFileExecute, editFileExecute };
}

export function createFileTools(deps: { repoRoot: string }) {
  const { readFileExecute, writeFileExecute, editFileExecute } = createFileExecutors(deps);
  return {
    readFileTool: tool({ description: readFileDescription, inputSchema: readFileSchema, execute: readFileExecute }),
    writeFileTool: tool({ description: writeFileDescription, inputSchema: writeFileSchema, execute: writeFileExecute }),
    editFileTool: tool({ description: editFileDescription, inputSchema: editFileSchema, execute: editFileExecute }),
  };
}
