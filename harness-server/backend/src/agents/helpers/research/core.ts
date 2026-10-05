import { z } from 'zod';

// The research helper's pure half (the `delegate` tool, see tool.ts): its
// schema, the subagent's instructions, cleaning up what a local model says,
// and packing the answers into as few tokens as possible for the paid agent.
// No `ai` import, so frontend/tests/harness-server/ can test it without a
// model.
//
// The point of delegating is saving the paid agent's context: every tool
// result it reads itself stays in its conversation and is re-read on every
// later step. A local subagent does the reading for free and hands back only
// the answer. So everything here leans toward returning less: a task that
// found nothing costs the paid agent a few characters, not a paragraph.

export const MAX_DELEGATE_TASKS = 4;
// One GPU serves every Ollama request; more than this at once just queues.
export const DELEGATE_PARALLEL = 2;
export const MAX_ANSWER_CHARS = 1_200;
export const NOTHING_FOUND = 'NOTHING_FOUND';
// Tool-result characters per token, the same estimate as the Token usage panel.
export const CHARS_PER_TOKEN = 4;

export const delegateSchema = z.object({
  tasks: z
    .array(
      z.object({
        task: z
          .string()
          .describe(
            'One precise, self-contained question about this repo, e.g. "Where is the retry delay for failed invoice ' +
              'uploads set? Give path:line." or "List the callers of parseEdiSegment with path:line."',
          ),
        paths: z
          .array(z.string())
          .optional()
          .describe('Files or folders to start from, if you know them (repo-relative)'),
      }),
    )
    .min(1)
    .max(MAX_DELEGATE_TASKS)
    .describe(`1-${MAX_DELEGATE_TASKS} independent questions; they run in parallel`),
});

export type DelegateInput = z.infer<typeof delegateSchema>;

export const delegateDescription =
  `Hand up to ${MAX_DELEGATE_TASKS} read-only questions about the repo to local helper agents, which run in ` +
  'parallel on this machine at no cost. Each one searches and reads files itself and returns only the answer ' +
  '(path:line facts, short snippets), so the files never enter your context. Use it for exploration: where ' +
  'something is defined or handled, who calls a function, whether a helper or pattern already exists, what a file ' +
  "or module does, which files a change will touch. Don't use it for text you are about to edit (read that range " +
  'yourself, since edit_file needs it verbatim), or for anything that needs judgment about the plan. Ask precise ' +
  'questions and ask for path:line. A task that finds nothing comes back as one line; then look yourself. The ' +
  'helpers are smaller models: check a surprising answer with a ranged read_file before relying on it.';

export const DELEGATE_SYSTEM_PROMPT = [
  'You are a research helper for a coding agent working in a code repository. You have read-only tools.',
  'Answer the one question you are given, using the tools to find the facts in the repo.',
  '',
  'Your answer is pasted into the coding agent\'s context, where every character costs money. So:',
  '- Give only the facts that answer the question: file paths with line numbers (path:line), names, and a short',
  '  code snippet (at most 10 lines) only when the exact text matters.',
  '- No preamble, no restating the question, no account of how you searched, no advice unless asked.',
  `- If you find nothing relevant, reply with exactly ${NOTHING_FOUND} and nothing else. Never guess.`,
  '- Stay under 150 words unless the question asks for a list.',
  '',
  'Start with search_code or search_docs. Use outline_file before read_file on a large file, and read only the',
  'line ranges you need.',
].join('\n');

// Appended to the coding agent's system prompt when it has the tool. The
// tool description carries the same guidance, since an app's prompt
// override replaces the base prompt and a resumed Claude session keeps its
// first system prompt.
export const DELEGATE_NOTE =
  '\n\n# Delegating exploration\n\nYou have `delegate`: local helper agents that search and read the repo for free ' +
  'and return only the answer. Everything you read yourself stays in your context and is re-read on every later ' +
  'step, so delegate exploration (where is X, who calls Y, does Z already exist, what does this module do), with ' +
  'independent questions batched into one call, and read_file yourself only the ranges you are about to edit.';

export function delegatePrompt(task: { task: string; paths?: string[] }): string {
  const paths = task.paths?.filter((p) => p.trim()) ?? [];
  return paths.length ? `${task.task}\n\nStart from: ${paths.join(', ')}` : task.task;
}

/** Validates and trims the tasks; throws on input the subagents can't use. */
export function normalizeTasks(input: DelegateInput): { task: string; paths?: string[] }[] {
  const tasks = input.tasks.map((t) => ({ ...t, task: t.task.trim() }));
  if (tasks.length === 0) throw new Error('Pass at least one task.');
  if (tasks.length > MAX_DELEGATE_TASKS) throw new Error(`Pass at most ${MAX_DELEGATE_TASKS} tasks.`);
  for (const [i, t] of tasks.entries()) {
    if (!t.task) throw new Error(`Task ${i + 1} is empty.`);
    if (t.task.length > 2_000) throw new Error(`Task ${i + 1} is over 2,000 characters; ask a shorter question.`);
  }
  return tasks;
}

/** Runs fn over items with at most `limit` in flight; results keep the input order. */
export async function runLimited<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

const PREAMBLE_RE =
  /^(sure|okay|ok|certainly|of course|great|alright|here('s| is| are)|based on|after (searching|reviewing|looking)|i (found|searched|looked|checked|have))\b.*[:.!]$/i;
const SIGN_OFF_RE = /^(let me know|hope this|feel free|if you (need|want|have)|i hope)\b/i;

/**
 * What a local model said, reduced to the answer: reasoning blocks, preamble
 * and sign-off lines removed, then cut to maxChars at a line break. Null when
 * there's nothing worth passing on (empty, or the NOTHING_FOUND reply).
 */
export function cleanAnswer(raw: string, maxChars = MAX_ANSWER_CHARS): string | null {
  let text = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*?<\/think>/i, '');
  // A reasoning block that never closed is all reasoning.
  if (/<think>/i.test(text)) text = text.slice(0, text.search(/<think>/i));
  text = text.trim();
  // Also when wrapped in markdown, or followed by an explanation.
  if (!text || text.replace(/^[`*\s]+/, '').toUpperCase().startsWith(NOTHING_FOUND)) return null;
  // A real answer with the sentinel tacked on after it.
  text = text.replace(new RegExp(`\\s+[\`*]*${NOTHING_FOUND}[\`*.]*\\s*$`, 'i'), '').trim();

  const lines = text.split('\n');
  while (lines.length > 1 && PREAMBLE_RE.test(lines[0].trim())) lines.shift();
  while (lines.length > 1 && (SIGN_OFF_RE.test(lines.at(-1)!.trim()) || !lines.at(-1)!.trim())) lines.pop();
  text = lines.join('\n').trim();
  if (!text) return null;

  if (text.length > maxChars) {
    const cut = text.lastIndexOf('\n', maxChars);
    text = `${text.slice(0, cut > maxChars / 2 ? cut : maxChars).trimEnd()}\n[cut]`;
  }
  return text;
}

export interface DelegateTaskResult {
  // The cleaned answer; null when the task found nothing or failed.
  answer: string | null;
  // Why it failed (timeout, Ollama unreachable, out of steps…); null otherwise.
  error: string | null;
  // Characters of tool output the subagent read — what the paid agent would
  // have read itself.
  readChars: number;
  // Local tokens the subagent spent (free).
  localTokens: number;
}

/**
 * The tool result the paid agent sees. Answers are numbered by task; tasks
 * that found nothing or failed share one short line, so they cost almost
 * nothing.
 */
export function formatResults(results: DelegateTaskResult[]): string {
  const numbered = results.map((r, i) => ({ ...r, n: i + 1 }));
  const useful = numbered.filter((r) => r.answer);
  const empty = numbered.filter((r) => !r.answer && !r.error);
  const failed = numbered.filter((r) => !r.answer && r.error);

  if (useful.length === 0 && failed.length === 0) return 'Nothing found. Look yourself, or ask a narrower question.';
  if (results.length === 1) {
    return useful.length ? useful[0].answer! : `Helper failed (${failed[0].error}). Do this one yourself.`;
  }
  const parts = useful.map((r) => `[${r.n}] ${r.answer}`);
  if (empty.length) parts.push(`Nothing found: ${empty.map((r) => r.n).join(', ')}.`);
  if (failed.length) {
    const reasons = [...new Set(failed.map((r) => r.error))].join('; ');
    parts.push(`Failed, do yourself: ${failed.map((r) => r.n).join(', ')} (${reasons}).`);
  }
  return parts.join('\n\n');
}

/**
 * Paid-context tokens the delegation avoided: everything the helpers read,
 * minus what came back. A lower bound, since a result the paid agent read
 * itself would also have been re-read on each later step.
 */
export function savedTokens(results: DelegateTaskResult[], returned: string): number {
  const read = results.reduce((acc, r) => acc + r.readChars, 0);
  return Math.max(0, Math.round((read - returned.length) / CHARS_PER_TOKEN));
}

export interface LocalUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const NO_USAGE: LocalUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const usageTotal = (u: LocalUsage) => u.input + u.output + u.cacheRead + u.cacheWrite;

/** One helper's run, as the tool's runner reports it. */
export interface HelperRun {
  text: string;
  // Set when the helper couldn't finish: unreachable model, timeout, a model error.
  error: string | null;
  usage: LocalUsage;
  readChars: number;
}

export interface DelegateReport {
  tasks: number;
  // Tasks that came back with an answer.
  useful: number;
  // Local tokens the helpers spent (free).
  usage: LocalUsage;
  // Paid-context tokens avoided (savedTokens above).
  savedTokens: number;
  // Characters the helpers' tools returned, and the text handed back.
  readChars: number;
  returnedChars: number;
}

export function shortError(message: string): string {
  if (/abort|timeout/i.test(message)) return 'timed out';
  if (/ECONNREFUSED|fetch failed|connect/i.test(message)) return 'Ollama not reachable';
  const line = message.split('\n')[0];
  return line.length > 100 ? `${line.slice(0, 100)}…` : line;
}

/**
 * Runs every task on a helper (DELEGATE_PARALLEL at a time) and returns the
 * text for the paid agent plus what the call spent and saved.
 */
export async function runDelegation(
  input: DelegateInput,
  runHelper: (prompt: string) => Promise<HelperRun>,
  parallel = DELEGATE_PARALLEL,
): Promise<{ text: string; report: DelegateReport }> {
  const tasks = normalizeTasks(input);
  const runs = await runLimited(tasks, parallel, (task) =>
    runHelper(delegatePrompt(task)).catch(
      (err): HelperRun => ({ text: '', error: err instanceof Error ? err.message : String(err), usage: NO_USAGE, readChars: 0 }),
    ),
  );
  const results: DelegateTaskResult[] = runs.map((run) => ({
    answer: run.error ? null : cleanAnswer(run.text),
    error: run.error ? shortError(run.error) : null,
    readChars: run.readChars,
    localTokens: usageTotal(run.usage),
  }));
  const text = formatResults(results);
  const usage = runs.reduce(
    (acc, r) => ({
      input: acc.input + r.usage.input,
      output: acc.output + r.usage.output,
      cacheRead: acc.cacheRead + r.usage.cacheRead,
      cacheWrite: acc.cacheWrite + r.usage.cacheWrite,
    }),
    NO_USAGE,
  );
  return {
    text,
    report: {
      tasks: tasks.length,
      useful: results.filter((r) => r.answer).length,
      usage,
      savedTokens: savedTokens(results, text),
      readChars: results.reduce((acc, r) => acc + r.readChars, 0),
      returnedChars: text.length,
    },
  };
}

const approxTokens = (chars: number) => {
  const t = Math.round(chars / CHARS_PER_TOKEN);
  return t >= 1000 ? `${(t / 1000).toFixed(t >= 10_000 ? 0 : 1)}k` : String(t);
};

/** One line for the chat transcript, e.g. "Local helpers (qwen3:8b): 2 of 3 answered · read ≈12k tokens · returned ≈80 · saved ≈11.9k paid tokens". */
export function delegateStatsLine(s: {
  model: string;
  tasks: number;
  useful: number;
  readChars: number;
  returnedChars: number;
  savedTokens: number;
}): string {
  return (
    `Local helpers (${s.model}): ${s.useful} of ${s.tasks} answered · read ≈${approxTokens(s.readChars)} tokens · ` +
    `returned ≈${approxTokens(s.returnedChars)} · saved ≈${approxTokens(s.savedTokens * CHARS_PER_TOKEN)} paid tokens`
  );
}
