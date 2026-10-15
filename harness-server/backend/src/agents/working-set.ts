import { readFileSync } from 'node:fs';
import path from 'node:path';
import { isListAllQuery } from './tool-defs/code-search-tool.js';

// The code a conversation was working on when it was cut, put into the
// handoff as it is on disk now. Without it, a conversation compacted
// mid-step spent a median of 15 calls re-reading the ranges it had just
// read and edited before it wrote anything again (150 cuts across the
// Oct 2026 sessions), and 23% of the cut conversations were cut again
// before writing at all.

interface Entry {
  role: string;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: unknown;
  toolCallId?: string;
}

export interface WorkingRange {
  path: string;
  start: number;
  // Inclusive; may run past the end of the file.
  end: number;
}

// The most recent reads and edits that make up the working set.
const RECENT_EVENTS = 15;
// read_file's default page.
const READ_PAGE_LINES = 300;
// Lines shown around an edit, so the next edit's oldText is in view.
const EDIT_CONTEXT_LINES = 5;
const WORKING_SET_CHARS = 12_000;
const RANGE_CHARS = 4_000;
const LISTING_CHARS = 3_000;

const bare = (name: string | undefined) => (name ?? '').replace(/^mcp__[^_]+(-[^_]+)?__/, '');

export function resultText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (Array.isArray(result)) {
    return result.map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : '')).join('\n');
  }
  return result == null ? '' : JSON.stringify(result);
}

/** Each tool call with its result, in call order. A result is paired by id, else by the next unpaired result. */
function pairCalls(entries: Entry[]): { name: string; input: Record<string, unknown>; result: string | null; isError: boolean }[] {
  const calls: { name: string; input: Record<string, unknown>; id?: string; result: string | null; isError: boolean }[] = [];
  for (const e of entries) {
    if (e.role === 'tool_call') {
      calls.push({ name: bare(e.toolName), input: (e.toolInput ?? {}) as Record<string, unknown>, id: e.toolCallId, result: null, isError: false });
    } else if (e.role === 'tool_result') {
      const call = (e.toolCallId && calls.find((c) => c.id === e.toolCallId)) || calls.find((c) => c.result === null);
      if (call) {
        call.result = resultText(e.toolResult);
        call.isError = Boolean((e as { isError?: boolean }).isError);
      }
    }
  }
  return calls;
}

/** The line ranges an edit_file result says the new text occupies. */
export function editedRanges(result: string): [number, number][] {
  const ranges: [number, number][] = [];
  for (const m of result.matchAll(/lines (\d+)-(\d+)|removed at line (\d+)/g)) {
    if (m[3]) ranges.push([Number(m[3]), Number(m[3])]);
    else ranges.push([Number(m[1]), Number(m[2])]);
  }
  return ranges;
}

/**
 * The ranges the conversation last read or edited, newest file first, each
 * file's ranges merged and in line order. A file it deleted is left out.
 */
export function workingSetRanges(entries: Entry[]): WorkingRange[] {
  const events: WorkingRange[] = [];
  for (const call of pairCalls(entries)) {
    const p = typeof call.input.path === 'string' ? call.input.path : null;
    if (!p || call.isError || call.result === null) continue;
    if (call.name === 'read_file') {
      if (/is unchanged since you last read it/.test(call.result.slice(0, 200))) continue;
      const symbol = typeof call.input.symbol === 'string' ? /lines (\d+)-(\d+)/.exec(call.result.split('\n')[0]) : null;
      if (symbol) {
        events.push({ path: p, start: Number(symbol[1]), end: Number(symbol[2]) });
        continue;
      }
      const offset = typeof call.input.offset === 'number' ? call.input.offset : 1;
      const limit = typeof call.input.limit === 'number' ? call.input.limit : READ_PAGE_LINES;
      events.push({ path: p, start: offset, end: offset + limit - 1 });
    } else if (call.name === 'edit_file') {
      if (!call.result.startsWith('Edited ')) continue;
      for (const [a, b] of editedRanges(call.result)) {
        events.push({ path: p, start: Math.max(1, a - EDIT_CONTEXT_LINES), end: b + EDIT_CONTEXT_LINES });
      }
    } else if (call.name === 'write_file') {
      if (!call.result.startsWith('Wrote ')) continue;
      events.push({ path: p, start: 1, end: READ_PAGE_LINES });
    } else if (call.name === 'delete_file') {
      events.push({ path: p, start: 0, end: -1 });
    }
  }

  const recent = events.slice(-RECENT_EVENTS);
  const deleted = new Set<string>();
  const order: string[] = [];
  const byPath = new Map<string, [number, number][]>();
  for (let i = recent.length - 1; i >= 0; i--) {
    const r = recent[i];
    if (r.end < r.start) {
      deleted.add(r.path);
      continue;
    }
    if (deleted.has(r.path)) continue;
    if (!byPath.has(r.path)) {
      byPath.set(r.path, []);
      order.push(r.path);
    }
    byPath.get(r.path)!.push([r.start, r.end]);
  }

  const out: WorkingRange[] = [];
  for (const p of order) {
    const sorted = byPath.get(p)!.sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    for (const [a, b] of sorted) {
      const last = merged.at(-1);
      if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
      else merged.push([a, b]);
    }
    for (const [start, end] of merged) out.push({ path: p, start, end });
  }
  return out;
}

/** The last match-all search_code listing, which agents otherwise run again after a cut. */
export function lastListing(entries: Entry[]): string | null {
  const listing = pairCalls(entries)
    .filter((c) => c.name === 'search_code' && typeof c.input.query === 'string' && isListAllQuery(c.input.query) && c.result && !c.isError)
    .at(-1);
  if (!listing?.result) return null;
  const glob = typeof listing.input.glob === 'string' ? ` (glob "${listing.input.glob}")` : '';
  const text = listing.result.length > LISTING_CHARS ? `${listing.result.slice(0, listing.result.lastIndexOf('\n', LISTING_CHARS))}\n[…]` : listing.result;
  return `The file listing you last asked search_code for${glob}:\n\n${text}`;
}

/** The working set as handoff sections, read from disk now. Empty when there's nothing to show. */
export function renderWorkingSet(repoRoot: string, entries: Entry[]): string {
  const blocks: string[] = [];
  let budget = WORKING_SET_CHARS;
  const contents = new Map<string, string[] | null>();
  for (const r of workingSetRanges(entries)) {
    if (budget <= 200) break;
    if (!contents.has(r.path)) {
      try {
        contents.set(r.path, readFileSync(path.join(repoRoot, r.path), 'utf8').split('\n'));
      } catch {
        contents.set(r.path, null);
      }
    }
    const lines = contents.get(r.path);
    if (!lines || r.start > lines.length) continue;
    const cap = Math.min(RANGE_CHARS, budget);
    let end = Math.min(r.end, lines.length);
    let chars = 0;
    for (let i = r.start - 1; i < end; i++) {
      chars += lines[i].length + 1;
      if (chars > cap) {
        end = i;
        break;
      }
    }
    if (end < r.start) continue;
    const text = lines.slice(r.start - 1, end).join('\n');
    budget -= text.length;
    blocks.push(`### ${r.path} — lines ${r.start}-${end} of ${lines.length}\n\n\`\`\`\n${text}\n\`\`\``);
  }
  const parts: string[] = [];
  if (blocks.length) {
    parts.push(
      '## Where you were working\n\nThe code you last read and edited, as it is on disk now. Use it as is: read_file ' +
        'only what lies outside these ranges.\n\n' +
        blocks.join('\n\n'),
    );
  }
  const listing = lastListing(entries);
  if (listing) parts.push(`## Files\n\n${listing}`);
  return parts.join('\n\n');
}
