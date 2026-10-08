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
export const MAX_ANSWER_CHARS = 2_400;
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
            'One precise question. Ask exactly what you need: a path:line for locations, a complete list ' +
              'for enumerations ("list all files under X", "does Y exist"), a name or short snippet for content. ' +
              'E.g. "Where is retryDelay for failed uploads set?" or "List all files under backend/src/db/."',
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
  `Hand up to ${MAX_DELEGATE_TASKS} read-only questions to local helpers running in parallel on this machine. ` +
  'They search and read the repo themselves; only the answer enters your context, not the files they read. ' +
  'Use for exploration: where something is defined, who calls a function, does a pattern already exist, ' +
  "which files a change touches, whether a file or directory exists, listing what's under a path. " +
  "Don't use for text you're about to edit (edit_file needs it verbatim — read that range yourself), " +
  'or for anything that needs judgment about the plan. ' +
  'Ask each task as a precise question: ask for a path:line, a complete list, or a yes/no with the path — ' +
  'whatever the question actually needs. A task that finds nothing comes back as one line. ' +
  'Verify a surprising answer with ranged read_file before acting.';

// How an answer is shaped, shared by the tool-loop helper and the built-in
// one-shot helper.
const ANSWER_RULES = [
  'Your answer is pasted directly into the coding agent\'s paid context. Give exactly what the question needs — no more, no less:',
  '- Location question ("where is X"): one path:line.',
  '- Caller question ("who calls X"): a list of path:line entries.',
  '- Existence question ("does X exist"): yes/no with the path.',
  '- Multi-file existence ("do these files exist: A, B, C"): one line per file — "A: missing", "B: 42 lines (path/A)", etc.',
  '- List question ("list files under Y", "list exported functions"): the complete list — every item, nothing omitted.',
  '- Verbatim quote ("quote X"): the exact text of the lines, with their line numbers.',
  '- Content question ("what does X do", "show the Y field"): one short sentence or the exact text, plus the key path:line.',
  '- Code snippet: only when the exact text was asked for, ≤8 lines unless the question asks for more.',
  '- No preamble, no restating the question, no account of how you searched, no advice.',
  `- If you genuinely find nothing after trying, reply with exactly ${NOTHING_FOUND} and nothing else. Never guess.`,
  '',
  'Completeness first: if the question asks for a list, return every item found — a truncated list is wrong.',
  'Brevity second: omit anything the question did not ask for.',
];

export const DELEGATE_SYSTEM_PROMPT = [
  'You are a research helper for a coding agent working in a code repository. You have read-only tools plus run_checked_command.',
  'Answer the one question you are given by USING THE TOOLS to find the facts in the repo, then write your answer.',
  'If the question asks about test or lint status, use run_checked_command and report only the failures (file, line, message) and a pass/fail count — never include raw stdout.',
  '',
  'CRITICAL: Your answer must contain ONLY the facts you found. Never mention tool names (search_code, read_file, outline_file, etc.) in your answer — those are how you find the answer, not what you say.',
  '',
  ...ANSWER_RULES,
  'Start with search_code or search_docs to locate the right file, then use outline_file before read_file on a large file.',
  'For existence questions, check the file directly with read_file, not just grep.',
  'For verbatim quotes, always read the file — do not report only the grep match line.',
  'Read only the line range that answers the question.',
].join('\n');

// The built-in Qwen has no tool calling: tool.ts reads the files up front and
// pastes excerpts below this prompt. Told about tools, it writes out the call
// it would make ("read_file: path") instead of an answer, so it isn't.
export const BUILTIN_SYSTEM_PROMPT = [
  'You are a research helper for a coding agent working in a code repository.',
  'You cannot open files or run anything. Answer the one question you are given using ONLY the "Repository context" below.',
  '',
  'How the context is shown:',
  '- Each file starts with "=== path (N lines) ===". Every line is prefixed with its line number and "|".',
  '- A file marked [complete] is shown in full.',
  '- In any other file, "… lines A-B not shown …" marks text you have NOT seen.',
  '',
  'CRITICAL:',
  '- Never say something is absent, missing or unused unless the file is marked [complete].',
  `- If the answer could be in lines not shown, or in a file not shown, reply with exactly ${NOTHING_FOUND}.`,
  '- Quote only text you can see. Use the line numbers shown; don\'t count lines yourself.',
  '- Never write "N/A", and never describe reading or searching — only the facts.',
  '',
  ...ANSWER_RULES,
].join('\n');

const QUOTED_RE = /`([^`\n]{1,80})`|'([^'\n]{1,80})'|"([^"\n]{1,80})"/g;
// A file path, or a file name with an extension: settings.test.ts, ../store.
const PATH_RE = /(?:[\w.-]*\/[\w./-]*|\b[\w-]+(?:\.[\w-]+)*\.(?:[jt]sx?|mjs|cjs|json|md|ya?ml|toml|rs|py|go|css|html|sh)\b)/g;

/**
 * Whether a question is about test or lint status, so the built-in helper
 * should run the check. File names ("settings.test.ts") and quoted text (a
 * test called '…reports an error') don't count — only the question's own
 * words, and only when they ask about passing, failing or running.
 */
export function wantsCheckRun(task: string): boolean {
  const words = task.replace(/\n\nStart from: .*$/s, '').replace(QUOTED_RE, ' ').replace(PATH_RE, ' ');
  if (!/\b(tests?|lint|linter|typecheck)\b/i.test(words)) return false;
  return /\b(pass(es|ing)?|fail(s|ing|ures?)?|green|broken|run)\b/i.test(words);
}

/**
 * What to look for inside a file: quoted strings ('../secure-store/store',
 * 'returns 404 when…') and code-shaped identifiers (appClient,
 * MOBILINK_DATA_DIR, Fn.importValue). File paths in the question aren't
 * terms — they say which file, not what to find in it.
 */
export function searchTerms(task: string): string[] {
  const question = task.replace(/\n\nStart from: .*$/s, '');
  const terms = new Set<string>();
  for (const m of question.matchAll(QUOTED_RE)) {
    const t = (m[1] ?? m[2] ?? m[3]).trim();
    if (t.length >= 3) terms.add(t);
  }
  const rest = question.replace(QUOTED_RE, ' ').replace(PATH_RE, ' ');
  for (const [word] of rest.matchAll(/\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\b/g)) {
    const codeShaped =
      word.includes('.') || word.includes('_') || /[a-z][A-Z]/.test(word) || /^[A-Z][a-z]+[A-Z]/.test(word) || /^[A-Z]{2,}\d*$/.test(word);
    if (codeShaped && word.length >= 3) terms.add(word);
  }
  return [...terms].slice(0, 12);
}

const HEAD_LINES = 40;
const WINDOW_LINES = 6;

/**
 * A file for the built-in helper: line-numbered, in full when it fits
 * maxChars ([complete]), otherwise its first lines plus a window around every
 * line that mentions a term, with each gap marked so the model knows what it
 * hasn't seen.
 */
export function excerptFile(label: string, text: string, terms: string[], maxChars: number): string {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const numbered = lines.map((l, i) => `${i + 1}| ${l}`);
  const full = `=== ${label} (${lines.length} lines) [complete] ===\n${numbered.join('\n')}`;
  if (full.length <= maxChars) return full;

  const keep = new Array<boolean>(lines.length).fill(false);
  for (let i = 0; i < Math.min(HEAD_LINES, lines.length); i++) keep[i] = true;
  const needles = terms.map((t) => t.toLowerCase());
  lines.forEach((line, i) => {
    const lower = line.toLowerCase();
    if (!needles.some((n) => lower.includes(n))) return;
    for (let j = Math.max(0, i - WINDOW_LINES); j <= Math.min(lines.length - 1, i + WINDOW_LINES); j++) keep[j] = true;
  });

  const header = `=== ${label} (${lines.length} lines) ===`;
  const out: string[] = [header];
  let size = header.length;
  let i = 0;
  while (i < lines.length) {
    if (!keep[i]) {
      const start = i;
      while (i < lines.length && !keep[i]) i++;
      out.push(`… lines ${start + 1}-${i} not shown …`);
      continue;
    }
    if (size + numbered[i].length + 1 > maxChars - 40) {
      out.push(`… lines ${i + 1}-${lines.length} not shown …`);
      break;
    }
    out.push(numbered[i]);
    size += numbered[i].length + 1;
    i++;
  }
  return out.join('\n');
}

// A reply that is only the tool call a model would have made, or a line of
// "N/A: not found" in place of the NOTHING_FOUND sentinel.
const TOOL_CALL_LINE_RE = /^(\[\d+\]\s*)?[`*]*(read_file|read_doc|search_code|search_docs|outline_file|run_checked_command)\b/i;
const NA_LINE_RE = /^(\[\d+\]\s*)?[`*]*N\/A\b/i;
// excerptFile's file header, copied into a quote.
const FILE_HEADER_RE = /^=== .+ \(\d+ lines\)( \[complete\])? ===$/;

// Appended to the coding agent's system prompt when it has the tool. The
// tool description carries the same guidance, since an app's prompt
// override replaces the base prompt and a resumed Claude session keeps its
// first system prompt.
export const DELEGATE_NOTE =
  '\n\n# Delegating exploration\n\n' +
  'You have `delegate`: local helpers that search and read the repo for free and hand back only the answer.\n\n' +
  '**Use it as your first move** for any exploration you would otherwise start a tool loop for: where is X ' +
  'defined, who calls Y, does this pattern or helper already exist, what does a module do, which files does a ' +
  'change touch.\n\n' +
  '**Batch independent questions into one call** — they run in parallel and the combined cost is one tool result ' +
  'instead of many. Group unrelated lookups that can happen at the same time.\n\n' +
  "**Don't delegate** text you are about to edit (you need it verbatim for edit_file — read that range yourself), " +
  'facts you already have in the conversation, or questions that need judgment about the plan.\n\n' +
  'A task that finds nothing comes back as one short line. Check a surprising answer with a ranged read_file ' +
  'before acting on it — the helpers are smaller models.';

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
  // "read_file: path" and "N/A: …" lines aren't findings; an answer made only
  // of them found nothing.
  text = lines
    .filter((l) => ![TOOL_CALL_LINE_RE, NA_LINE_RE, FILE_HEADER_RE].some((re) => re.test(l.trim())))
    .join('\n')
    .trim();
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
  // Repo-relative files the helper read, to spot the paid agent reading
  // them again (RedoLedger).
  paths?: string[];
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
  // Files the helpers read, across every task.
  paths: string[];
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
      paths: [...new Set(runs.flatMap((r) => (r.error ? [] : (r.paths ?? []))))],
    },
  };
}

const normalizePath = (p: string) => p.replace(/^\.\//, '');

/**
 * Keeps delegation stats honest. A delegation's answer only saved the paid
 * agent anything if the agent didn't go and read the same files anyway; in
 * the logs it mostly did. Each delegation that came back with an answer is
 * remembered with the files its helpers read; the first paid read of one of
 * them hands its stats back, once, so the caller can log a correction that
 * cancels them.
 */
export class RedoLedger {
  private open: { paths: Set<string>; useful: number; savedTokens: number }[] = [];

  record(paths: string[], useful: number, savedTokens: number): void {
    if (useful <= 0 || paths.length === 0) return;
    this.open.push({ paths: new Set(paths.map(normalizePath)), useful, savedTokens });
  }

  /** Delegations the paid agent just redid by reading `filePath`; each is returned at most once. */
  noteRead(filePath: string): { useful: number; savedTokens: number }[] {
    const p = normalizePath(filePath);
    const redone = this.open.filter((d) => d.paths.has(p));
    if (redone.length === 0) return [];
    this.open = this.open.filter((d) => !d.paths.has(p));
    return redone.map(({ useful, savedTokens }) => ({ useful, savedTokens }));
  }
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
