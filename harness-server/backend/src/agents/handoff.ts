import type { TranscriptEntry } from '../sessions/session.js';
import { commitLogAgainstBase, diffStatAgainstBase, shortStatus } from '../repo/git.js';
import { generateLocal } from './local-llm.js';
import type { AgentEvent } from './sdk-client.js';

// A coding conversation re-sends its whole context on every tool step, so
// cost grows with (steps × context). Rather than let one conversation run
// across every plan step, the coding agent and team members start a fresh
// one at step boundaries and when a context gets large (see coding-agent.ts
// and the `compaction` option in sdk-client.ts). The fresh conversation
// opens with this handoff: what's on disk and in git, read straight from the
// repo, plus notes on the previous conversation written by Riff's built-in
// Qwen — free, and the only part that needs judgment. Without Qwen, the
// notes fall back to the agent's own last message and the files it touched.

export type ContextEntry = Omit<TranscriptEntry, 'id' | 'timestamp'>;

/** Collects one conversation's events in transcript shape, for a mid-turn handoff. */
export class ContextLog {
  entries: ContextEntry[] = [];

  constructor(initial: ContextEntry[] = []) {
    this.entries = [...initial];
  }

  record(event: AgentEvent): void {
    if (event.type === 'assistant_text') this.entries.push({ role: 'assistant', text: event.text });
    else if (event.type === 'tool_call') this.entries.push({ role: 'tool_call', toolName: event.name, toolInput: event.input });
    else if (event.type === 'tool_result') this.entries.push({ role: 'tool_result', toolResult: event.content, isError: event.isError });
  }

  reset(): void {
    this.entries = [];
  }
}

/** Transcript entries after `startEntryId` (all of them when it's null or no longer found). */
export function entriesSince(entries: TranscriptEntry[], startEntryId: string | null | undefined): TranscriptEntry[] {
  if (!startEntryId) return entries;
  const i = entries.findIndex((e) => e.id === startEntryId);
  return i === -1 ? entries : entries.slice(i + 1);
}

const toolName = (name: string | undefined) => (name ?? '').replace(/^mcp__[^_]+(-[^_]+)?__/, '');

function inputPath(input: unknown): string | null {
  const p = (input as { path?: unknown } | null)?.path;
  return typeof p === 'string' ? p : null;
}

function resultText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (Array.isArray(result)) {
    return result.map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : '')).join('\n');
  }
  return JSON.stringify(result ?? '');
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)} […]` : text);

// What the notes model sees: the agent's words and a one-line form of each
// tool call, with only failed results (the passing ones are noise here).
// Newest kept when over budget — the end is where "in progress" lives.
const ACTIVITY_CHAR_BUDGET = 14_000;

function activityLog(entries: ContextEntry[]): string {
  const lines: string[] = [];
  for (const e of entries) {
    if (e.role === 'user' && e.text) lines.push(`HUMAN: ${clip(e.text, 800)}`);
    else if (e.role === 'assistant' && e.text) lines.push(`AGENT: ${clip(e.text, 1200)}`);
    else if (e.role === 'tool_call') {
      const name = toolName(e.toolName);
      const input = e.toolInput as Record<string, unknown> | undefined;
      const detail =
        inputPath(input) ??
        (typeof input?.command === 'string' ? input.command : null) ??
        (typeof input?.query === 'string' ? `"${input.query}"` : null) ??
        (typeof input?.message === 'string' ? `"${clip(input.message, 120)}"` : null) ??
        '';
      lines.push(`[${name}${detail ? ` ${detail}` : ''}]`);
    } else if (e.role === 'tool_result') {
      const text = resultText(e.toolResult);
      if (e.isError || /\b(failed|error)\b/i.test(text.slice(0, 200))) lines.push(`  ↳ ${clip(text.replace(/\s+/g, ' '), 600)}`);
    }
  }
  const kept: string[] = [];
  let total = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (total + lines[i].length > ACTIVITY_CHAR_BUDGET && kept.length > 0) break;
    kept.unshift(lines[i]);
    total += lines[i].length + 1;
  }
  if (kept.length < lines.length) kept.unshift(`[${lines.length - kept.length} earlier lines omitted]`);
  return kept.join('\n');
}

const NOTES_SYSTEM = `You write handoff notes for a software engineer who is taking over an in-progress coding task and cannot see the previous conversation. From the activity log, write short Markdown bullets under exactly these headings:

### Done
### In progress
### Learned
### Next

"Learned" is for facts about the codebase worth not rediscovering: where things live, conventions, commands, gotchas, which tests fail and why. Use only facts in the log, be concrete (file paths, function names, error messages), no preamble, at most 250 words. Write "- none" under a heading with nothing to say.`;

async function qwenNotes(entries: ContextEntry[]): Promise<string | null> {
  const log = activityLog(entries);
  if (!log.trim()) return null;
  try {
    const raw = await generateLocal({ system: NOTES_SYSTEM, prompt: `Activity log:\n\n${log}`, maxTokens: 700 });
    const text = raw.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^```(?:markdown|md)?\s*|\s*```$/g, '').trim();
    return text.includes('### ') && text.length > 40 ? text : null;
  } catch (err) {
    console.warn('[handoff] local model unavailable for handoff notes —', err instanceof Error ? err.message : err);
    return null;
  }
}

function filesTouched(entries: ContextEntry[]): { changed: string[]; read: string[] } {
  const changed = new Set<string>();
  const read = new Map<string, string[]>();
  for (const e of entries) {
    if (e.role !== 'tool_call') continue;
    const name = toolName(e.toolName);
    const p = inputPath(e.toolInput);
    if (!p) continue;
    if (name === 'write_file' || name === 'edit_file') changed.add(p);
    if (name === 'read_file') {
      const { offset, limit } = (e.toolInput ?? {}) as { offset?: number; limit?: number };
      const ranges = read.get(p) ?? [];
      if (offset || limit) ranges.push(`${offset ?? 1}+${limit ?? '…'}`);
      read.set(p, ranges);
    }
  }
  return {
    changed: [...changed],
    read: [...read.entries()].filter(([p]) => !changed.has(p)).map(([p, r]) => (r.length ? `${p} (lines ${r.join(', ')})` : p)),
  };
}

export interface HandoffParams {
  reason: string;
  entries: ContextEntry[];
  repoRoot: string;
  // Commits and diff stat are taken against this; left out when unset.
  branch?: string | null;
  baseBranch?: string;
  checklist?: { id: string; title: string; status: string }[] | null;
}

export async function buildHandoff(params: HandoffParams): Promise<string> {
  const { reason, entries, repoRoot, branch, baseBranch, checklist } = params;
  const [notes, status, commits, stat] = await Promise.all([
    qwenNotes(entries),
    shortStatus(repoRoot).catch(() => ''),
    branch && baseBranch ? commitLogAgainstBase(repoRoot, branch, baseBranch).catch(() => []) : Promise.resolve([]),
    branch && baseBranch ? diffStatAgainstBase(repoRoot, branch, baseBranch).catch(() => '') : Promise.resolve(''),
  ]);
  const { changed, read } = filesTouched(entries);

  const parts = [
    `# Picking up from an earlier conversation\n\n${reason} The earlier conversation was cleared to save tokens; ` +
      'everything on disk and in git is intact. Work from the notes and state below, and read files again only ' +
      'for the parts you need now.',
  ];
  if (checklist && checklist.length > 0) {
    // Finished steps by id only: write_coding_plan merges by id, so the
    // agent never needs to repeat them.
    const done = checklist.filter((s) => s.status === 'done');
    const open = checklist.filter((s) => s.status !== 'done');
    const lines = open.map((s) => `- [${s.status}] ${s.title} (id: "${s.id}")`);
    if (done.length > 0) lines.unshift(`- [done] ${done.length} of ${checklist.length}: ${done.map((s) => s.id).join(', ')}`);
    parts.push(`## Checklist\n\n${lines.join('\n')}`);
  }
  if (commits.length > 0) {
    parts.push(`## Commits so far\n\n${commits.slice(0, 15).map((c) => `- ${c.message.split('\n')[0]}`).join('\n')}`);
  }
  if (stat.trim()) parts.push(`## Files changed on the branch\n\n\`\`\`\n${clip(stat.trim(), 2500)}\n\`\`\``);
  parts.push(`## Uncommitted changes\n\n${status.trim() ? `\`\`\`\n${clip(status.trim(), 2000)}\n\`\`\`` : 'None.'}`);

  if (notes) {
    parts.push(`## Notes from the previous conversation\n\n${notes}`);
  } else {
    const lastText = [...entries].reverse().find((e) => e.role === 'assistant' && e.text)?.text;
    if (lastText) parts.push(`## Your last message in the previous conversation\n\n${clip(lastText, 2000)}`);
  }
  if (changed.length > 0) parts.push(`## Files you changed\n\n${changed.map((p) => `- ${p}`).join('\n')}`);
  if (read.length > 0) parts.push(`## Files you read (not changed)\n\n${read.slice(0, 40).map((p) => `- ${p}`).join('\n')}`);
  return parts.join('\n\n');
}
