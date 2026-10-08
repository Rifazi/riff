import { readFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { tool, type ToolSet } from 'ai';
import { OUT_OF_STEPS, runAgentTurn } from '../../sdk-client.js';
import {
  delegateDescription,
  delegateSchema,
  delegateStatsLine,
  BUILTIN_SYSTEM_PROMPT,
  DELEGATE_SYSTEM_PROMPT,
  excerptFile,
  runDelegation,
  RedoLedger,
  searchTerms,
  wantsCheckRun,
  type DelegateInput,
  type HelperRun,
} from './core.js';
import { reportHelperRedo, reportHelperRun, type HelperContext } from '../helper.js';
import { createDocsSearchTools } from '../../tool-defs/docs-search-tool.js';
import { createSearchCodeTool } from '../../tool-defs/code-search-tool.js';
import { createOutlineFileTool } from '../../tool-defs/outline-tool.js';
import { createFileExecutors, readFileDescription, readFileSchema } from '../../tool-defs/file-tools.js';
import { createQaExecutors, runCheckedCommandSchema, runCheckedCommandDescription, type CheckCommand } from '../../tool-defs/qa-tools.js';
import { generateLocal } from '../../local-llm.js';

const execFileAsync = promisify(execFile);

export { delegateSchema, delegateDescription, DELEGATE_NOTE } from './core.js';

// Special model ID that routes to Riff's built-in Qwen (llama-helper) instead
// of Ollama. No tool calling — runBuiltinHelper reads the files for it and it
// answers in one shot.
export const BUILTIN_MODEL_ID = 'builtin';

// The research helper: each `delegate` task is a short, read-only tool loop
// on the coding role's `delegateModel` in the system Ollama
// (settings/ollama.ts).
const HELPER_STEPS = 12;
const HELPER_TIMEOUT_MS = 180_000;
// Local models often run with a small context window: a helper reads in
// smaller pages than the paid agent does.
const HELPER_READ_LINES = 250;

export interface DelegateDeps {
  repoRoot: string;
  appId: string;
  sessionId?: string;
  model: string;
  checkCommands?: Partial<Record<CheckCommand, string>>;
  // Where each run is reported (helpers/helper.ts).
  context?: HelperContext;
  // Defaults to a real helper on Ollama.
  runHelper?: (prompt: string) => Promise<HelperRun>;
  // Answered delegations and the files behind them, per agent turn (see noteDelegateRead).
  ledger?: RedoLedger;
}

/**
 * The delegate tool's deps. When no Ollama model is configured, falls back to
 * the built-in Qwen (BUILTIN_MODEL_ID) so the tool is always available without
 * any user configuration. Pass `null` explicitly only to disable it entirely.
 */
export function delegateDeps(params: {
  model: string | null | undefined;
  repoRoot: string;
  appId: string;
  context: HelperContext;
  checkCommands?: Partial<Record<CheckCommand, string>>;
}): DelegateDeps {
  const model = params.model?.trim() || BUILTIN_MODEL_ID;
  return {
    repoRoot: params.repoRoot,
    appId: params.appId,
    sessionId: params.context.sessionId,
    model,
    checkCommands: params.checkCommands,
    context: params.context,
    ledger: new RedoLedger(),
  };
}

export function createDelegateExecute(deps: DelegateDeps) {
  const runHelper =
    deps.runHelper ??
    (deps.model === BUILTIN_MODEL_ID
      ? (prompt: string) => runBuiltinHelper(deps, prompt)
      : (prompt: string) => runOllamaHelper(deps, prompt));
  return async (input: DelegateInput): Promise<string> => {
    const { text, report } = await runDelegation(input, runHelper);
    const { usage, paths, ...rest } = report;
    const stats = { helper: 'research' as const, model: deps.model, ...rest, localTokens: usage.input + usage.output };
    await reportHelperRun(deps.context, stats, delegateStatsLine(stats), usage);
    deps.ledger?.record(paths, report.useful, report.savedTokens);
    return text;
  };
}

/**
 * Called by the paid agent's read_file. Reading a file a delegation's helpers
 * already read means the answer didn't spare the agent that read, so the
 * delegation's useful count and saving are taken back in the usage log.
 */
export function noteDelegateRead(deps: DelegateDeps | null | undefined, filePath: string): void {
  if (!deps?.ledger) return;
  for (const redo of deps.ledger.noteRead(filePath)) {
    void reportHelperRedo(deps.context, 'research', redo.useful, redo.savedTokens);
  }
}

async function runOllamaHelper(deps: DelegateDeps, prompt: string): Promise<HelperRun> {
  const { readFileExecute } = createFileExecutors({ repoRoot: deps.repoRoot });
  const readPaths = new Set<string>();
  const { searchDocsTool, readDocTool } = createDocsSearchTools({
    appId: deps.appId,
    sessionId: deps.sessionId,
    repoRoot: deps.repoRoot,
  });
  const { runCheckedCommandExecute } = createQaExecutors({ repoRoot: deps.repoRoot, checkCommands: deps.checkCommands });
  const tools: ToolSet = {
    search_code: createSearchCodeTool({ repoRoot: deps.repoRoot }),
    search_docs: searchDocsTool,
    read_doc: readDocTool,
    outline_file: createOutlineFileTool({ repoRoot: deps.repoRoot }),
    read_file: tool({
      description: readFileDescription,
      inputSchema: readFileSchema,
      execute: (args) => {
        readPaths.add(args.path);
        return readFileExecute({ ...args, limit: args.limit ?? HELPER_READ_LINES });
      },
    }),
    run_checked_command: tool({
      description: runCheckedCommandDescription,
      inputSchema: runCheckedCommandSchema,
      execute: runCheckedCommandExecute,
    }),
  };

  let readChars = 0;
  let modelError: string | null = null;
  const result = await runAgentTurn({
    systemPrompt: DELEGATE_SYSTEM_PROMPT,
    tools,
    provider: 'ollama',
    model: deps.model,
    apiKey: '',
    history: [],
    prompt,
    // Only read here: nothing reaches the paid agent's event stream.
    onEvent: (event) => {
      if (event.type === 'error') modelError ??= event.message;
      if (event.type === 'usage') readChars = Object.values(event.toolOutput ?? {}).reduce((acc, s) => acc + s.chars, 0);
    },
    compaction: { atTokens: Infinity, handoff: async () => ({ prompt: '' }), stepsPerHop: HELPER_STEPS, maxHops: 0 },
    abortSignal: AbortSignal.timeout(HELPER_TIMEOUT_MS),
  });
  // A helper that ran out of steps found nothing it could stand behind:
  // reported like nothing found, which costs the paid agent the least.
  const outOfSteps = result.isError && result.resultText.startsWith(OUT_OF_STEPS);
  return { text: outOfSteps ? '' : result.resultText, error: modelError, usage: result.usage, readChars, paths: [...readPaths] };
}

// The built-in Qwen has a 16k-token window; code runs ~3 chars/token, and the
// prompt and answer need room too.
const BUILTIN_CONTEXT_CHARS = 24_000;
const BUILTIN_MAX_FILES = 4;
const GREP_OUTPUT_CHARS = 3_000;
const CHECK_OUTPUT_CHARS = 4_000;

// A repo-relative path for `p`, or null when it points outside the repo.
function repoRelative(repoRoot: string, p: string): string | null {
  const abs = path.resolve(repoRoot, p);
  const rel = path.relative(repoRoot, abs);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : null;
}

// `git grep` for the question's terms, fixed strings and no shell, so nothing
// in the question can run. Returns the hit lines and the files they're in,
// most hits first.
async function grepTerms(repoRoot: string, terms: string[]): Promise<{ output: string; files: string[] }> {
  if (terms.length === 0) return { output: '', files: [] };
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['grep', '-n', '-I', '-i', '-F', '--max-count=8', ...terms.flatMap((t) => ['-e', t]), '--', '.'],
      { cwd: repoRoot, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
    );
    const lines = stdout.trim().split('\n').filter(Boolean);
    const counts = new Map<string, number>();
    for (const line of lines) {
      const m = line.match(/^([^:]+):\d+:/);
      if (m) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
    }
    let output = '';
    for (const line of lines) {
      const cut = line.length > 200 ? `${line.slice(0, 200)}…` : line;
      if (output.length + cut.length + 1 > GREP_OUTPUT_CHARS) break;
      output += `${cut}\n`;
    }
    return { output: output.trim(), files: [...counts].sort((a, b) => b[1] - a[1]).map(([f]) => f) };
  } catch {
    // Exit 1 is "no matches"; anything else, the helper answers without it.
    return { output: '', files: [] };
  }
}

// Built-in Qwen helper: no tool calling, so it gets the files up front —
// the `paths` it was given, else the files its question's terms turn up —
// line-numbered, in full or as excerpts around those terms, and answers in
// one generateLocal() call.
async function runBuiltinHelper(deps: DelegateDeps, prompt: string): Promise<HelperRun> {
  const task = prompt; // delegatePrompt() output — the question text
  const pathMatches = prompt.match(/Start from: (.+)$/m);
  const explicitPaths = pathMatches ? pathMatches[1].split(',').map((p) => p.trim()) : [];
  const terms = searchTerms(task);
  const contextParts: string[] = [];
  let readChars = 0;

  if (wantsCheckRun(task)) {
    const command: CheckCommand = /\blint\b/i.test(task) ? 'lint' : 'test';
    const { runCheckedCommandExecute } = createQaExecutors({ repoRoot: deps.repoRoot, checkCommands: deps.checkCommands });
    try {
      const result = (await runCheckedCommandExecute({ command })).slice(0, CHECK_OUTPUT_CHARS);
      contextParts.push(`=== ${command} output ===\n${result}`);
      readChars += result.length;
    } catch {
      // command not available or repo has no such script — skip
    }
  }

  const files: string[] = [];
  for (const p of explicitPaths) {
    const rel = repoRelative(deps.repoRoot, p);
    if (!rel) continue;
    const s = await stat(path.join(deps.repoRoot, rel)).catch(() => null);
    if (s?.isFile()) files.push(rel);
  }
  if (files.length === 0) {
    const grep = await grepTerms(deps.repoRoot, terms);
    if (grep.output) {
      contextParts.push(`=== where the question's terms appear (path:line:text) ===\n${grep.output}`);
      readChars += grep.output.length;
    }
    files.push(...grep.files.slice(0, 2));
  }

  const chosen = [...new Set(files)].slice(0, BUILTIN_MAX_FILES);
  let budget = BUILTIN_CONTEXT_CHARS - contextParts.reduce((acc, p) => acc + p.length, 0);
  for (const [i, rel] of chosen.entries()) {
    const text = await readFile(path.join(deps.repoRoot, rel), 'utf8').catch(() => null);
    if (text === null) continue;
    const chunk = excerptFile(rel, text, terms, Math.floor(budget / (chosen.length - i)));
    contextParts.push(chunk);
    readChars += chunk.length;
    budget -= chunk.length;
  }

  const context = contextParts.join('\n\n');
  const system = BUILTIN_SYSTEM_PROMPT + `\n\n# Repository context\n\n${context || '(nothing found for this question)'}`;

  try {
    const raw = await generateLocal({ system, prompt: task, maxTokens: 800 });
    return { text: raw, error: null, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, readChars, paths: chosen };
  } catch (err) {
    return {
      text: '',
      error: err instanceof Error ? err.message : String(err),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      readChars,
    };
  }
}

export function createDelegateTool(deps: DelegateDeps) {
  return tool({ description: delegateDescription, inputSchema: delegateSchema, execute: createDelegateExecute(deps) });
}

/**
 * The AI-SDK `delegate` entry for a tool set. Always includes the tool using
 * the builtin Qwen when no Ollama model is set. Pass `null` for `deps` only
 * when the tool must be kept disabled while a replayed history still references
 * it — a refusing stub keeps those histories valid.
 */
export function delegateToolEntry(deps: DelegateDeps | null, history: unknown[]): ToolSet {
  if (deps) return { delegate: createDelegateTool(deps) };
  if (!JSON.stringify(history).includes('"toolName":"delegate"')) return {};
  return {
    delegate: createDelegateTool({
      repoRoot: '',
      appId: '',
      model: '',
      runHelper: async () => {
        throw new Error('the local helpers are turned off in Settings');
      },
    }),
  };
}
