// Two compression strategies that use the built-in Qwen to shrink what the
// paid agent sees, reducing cache-read costs on every subsequent request:
//
//  tryCompressCode     — applied to a single large read_file result at the
//                        moment it's returned, before it enters the history.
//  compressMessages    — applied to the accumulated history just before each
//                        API call, compressing any large tool result that was
//                        not yet compressed at entry time (e.g. diffs, command
//                        output from an earlier session, non-code files).

import type { ModelMessage } from 'ai';
import { generateLocal } from '../local-llm.js';

// Below this size a file isn't worth the round-trip to Qwen.
const MIN_CHARS = 3_000;
// Cap what we feed Qwen — it has a context window.
const MAX_INPUT_CHARS = 12_000;
// Only bother if the result is at least this much smaller than the input.
const MIN_SAVINGS_RATIO = 0.25;

// File extensions worth compressing (structured code with bodies to strip).
const COMPRESSIBLE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.rs', '.go', '.java', '.cs', '.cpp', '.c',
]);

export function isCompressiblePath(filePath: string): boolean {
  const dot = filePath.lastIndexOf('.');
  return dot >= 0 && COMPRESSIBLE_EXTS.has(filePath.slice(dot));
}

const SYSTEM = [
  'You compress source code so a coding agent can hold more files in its memory.',
  'Given a source file, output a compact version that preserves everything the agent needs to understand',
  'the file\'s API and structure, without the implementation details.',
  '',
  'KEEP verbatim:',
  '- All import and export statements',
  '- All function, class, method, interface, type, and enum declarations (names + signatures)',
  '- All top-level constants, config values, and string/number literals used as identifiers',
  '- Error messages and thrown strings',
  '- Short function bodies (3 lines or fewer)',
  '',
  'REPLACE with a single // ... comment:',
  '- Function and method bodies longer than 3 lines',
  '- Long switch/if-else chains where the structure is clear from the case labels',
  '',
  'REMOVE:',
  '- Multi-line JSDoc comments (keep single-line descriptions)',
  '- Blank lines between items (keep one blank line between top-level declarations)',
  '',
  'Output ONLY the compressed code. No preamble, no explanation, no markdown fences.',
].join('\n');

// Cache: raw-content hash → compressed output.
// Shared across all calls in the same process so we never compress the same
// file twice, even when two agents in a team run concurrently.
const cache = new Map<string, string>();

function contentHash(s: string): string {
  // FNV-1a 32-bit — fast, no crypto import needed.
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return h.toString(16);
}

/**
 * Tries to compress `content` using the built-in Qwen model.
 * Returns the original string unchanged on any error or if compression
 * doesn't save enough to be worth the added note.
 *
 * Only call this for full-file reads (no offset/limit). Never call it for
 * ranged reads — those are for editing and need verbatim text.
 */
export async function tryCompressCode(filePath: string, content: string): Promise<string> {
  if (!isCompressiblePath(filePath)) return content;
  if (content.length < MIN_CHARS) return content;

  const key = `${filePath}:${contentHash(content)}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  try {
    const input = content.length > MAX_INPUT_CHARS ? content.slice(0, MAX_INPUT_CHARS) : content;
    const truncated = content.length > MAX_INPUT_CHARS;
    const compressed = await generateLocal({
      system: SYSTEM,
      prompt: `// ${filePath}\n${input}`,
      // Give Qwen enough room to output most of the signatures, but no more
      // than half the input — if it needs more than that, compression isn't
      // happening and we should just use the original.
      maxTokens: Math.max(600, Math.round(input.length / 2)),
    });

    if (!compressed || compressed.length >= input.length * (1 - MIN_SAVINGS_RATIO)) {
      cache.set(key, content);
      return content;
    }

    const truncNote = truncated ? ` (file truncated at ${MAX_INPUT_CHARS} chars before compression)` : '';
    const result = `[compressed${truncNote} — use ranged read_file before editing]\n${compressed}`;
    cache.set(key, result);
    return result;
  } catch {
    cache.set(key, content);
    return content;
  }
}

// ---------------------------------------------------------------------------
// Plan preamble compression — runs once at plan-approval time
// ---------------------------------------------------------------------------

const PREAMBLE_MIN_CHARS = 1_000;
const PREAMBLE_MAX_INPUT = 10_000;

const PREAMBLE_SYSTEM =
  'You compress the introductory section of a technical plan document so a coding agent can hold it in memory cheaply. ' +
  'The coding agent already has the full plan available on request; this is the context it reads on every turn. ' +
  'Produce a dense ≤500-character summary. Keep: key architectural decisions, chosen libraries/patterns, ' +
  'explicit constraints and "do not" rules, cross-step dependencies. ' +
  'Drop: rationale, comparisons, background prose, anything that just restates the steps. ' +
  'Output only the summary text — no labels, no preamble.';

/**
 * Compresses the plan preamble (everything before the Steps section) using
 * local Qwen. Returns the compressed text, or null if the preamble is too
 * short to be worth compressing or Qwen is unavailable.
 *
 * Called once at plan-approval time. The result is stored in the plan
 * frontmatter as `preambleSummary` and used by planExcerpt() on every
 * coding conversation instead of the full preamble.
 */
export async function tryCompressPlanPreamble(preamble: string): Promise<string | null> {
  const text = preamble.trim();
  if (text.length < PREAMBLE_MIN_CHARS) return null;

  const key = `preamble:${contentHash(text)}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached || null;

  try {
    const input = text.length > PREAMBLE_MAX_INPUT ? text.slice(0, PREAMBLE_MAX_INPUT) : text;
    const summary = await generateLocal({ system: PREAMBLE_SYSTEM, prompt: input, maxTokens: 200 });
    if (!summary || summary.length >= text.length * (1 - MIN_SAVINGS_RATIO)) {
      cache.set(key, '');
      return null;
    }
    cache.set(key, summary);
    return summary;
  } catch {
    cache.set(key, '');
    return null;
  }
}

// ---------------------------------------------------------------------------
// History compression — shrinks accumulated tool results before each API call
// ---------------------------------------------------------------------------

// Tool result text below this length isn't worth a Qwen round-trip.
const HIST_MIN = 1_500;
// Cap what we feed Qwen per tool result.
const HIST_MAX_INPUT = 8_000;

const HIST_SYSTEM =
  'You compress a tool result for a coding agent. ' +
  'Keep: path:line references, function/type names, error messages, key values and counts. ' +
  'Remove: verbose output, repeated lines, boilerplate, redundant stack frames. ' +
  'Output only the compressed text — no preamble.';

/** Extract the text string from a tool result `content` field (string or TextPart[]). */
function extractResultText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const joined = content
      .map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : ''))
      .join('\n');
    return joined || null;
  }
  return null;
}

async function compressToolResult(text: string): Promise<string> {
  const key = `hist:${contentHash(text)}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  try {
    const input = text.length > HIST_MAX_INPUT ? text.slice(0, HIST_MAX_INPUT) : text;
    const compressed = await generateLocal({
      system: HIST_SYSTEM,
      prompt: input,
      maxTokens: Math.max(300, Math.round(input.length / 3)),
    });
    if (!compressed || compressed.length >= text.length * (1 - MIN_SAVINGS_RATIO)) {
      cache.set(key, text);
      return text;
    }
    const result = `[compressed]\n${compressed}`;
    cache.set(key, result);
    return result;
  } catch {
    cache.set(key, text);
    return text;
  }
}

/**
 * Walks the AI SDK message history and compresses any large tool result
 * content using the built-in Qwen model. Returns a new array; the original
 * is never mutated. Identical content is only compressed once (cached).
 *
 * Only call this on the copy being sent to the model — not on the canonical
 * history used for compaction/handoff, which needs full content.
 */
export async function compressMessages(history: ModelMessage[]): Promise<ModelMessage[]> {
  if (history.length === 0) return history;

  // Collect jobs: (message index, part index, text to compress).
  type Job = { msgIdx: number; partIdx: number; origText: string };
  const jobs: Job[] = [];

  for (let i = 0; i < history.length; i++) {
    const msg = history[i];
    if (msg.role !== 'tool') continue;
    const parts = msg.content as Array<Record<string, unknown>>;
    if (!Array.isArray(parts)) continue;
    for (let j = 0; j < parts.length; j++) {
      // ToolResultPart.content holds the tool's return value.
      const text = extractResultText(parts[j]['content']);
      if (text && text.length >= HIST_MIN) jobs.push({ msgIdx: i, partIdx: j, origText: text });
    }
  }

  if (jobs.length === 0) return history;

  // Compress all candidates (Qwen serialises them internally).
  const compressed = await Promise.all(jobs.map((j) => compressToolResult(j.origText)));

  // If nothing actually shrank, return the original array unchanged.
  if (jobs.every((_, k) => compressed[k] === jobs[k].origText)) return history;

  // Build a new history array, replacing only the parts that changed.
  return history.map((msg, i) => {
    if (msg.role !== 'tool') return msg;
    const updates = jobs
      .map((j, k) => ({ ...j, compressedText: compressed[k] }))
      .filter((j) => j.msgIdx === i && j.compressedText !== j.origText);
    if (updates.length === 0) return msg;
    const parts = [...(msg.content as Array<Record<string, unknown>>)];
    for (const u of updates) parts[u.partIdx] = { ...parts[u.partIdx], content: u.compressedText };
    return { ...msg, content: parts } as ModelMessage;
  });
}
