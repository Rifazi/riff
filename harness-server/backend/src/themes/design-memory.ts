import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

/**
 * What the human has asked for about an app's look, kept across sessions and
 * UI/UX passes. The theme file holds values; this holds intent ("the sidebar
 * stays flat", "no glow on the dashboard") that a later pass would otherwise
 * not know about and quietly undo. Machine-local like local-apps.json.
 */
export interface DesignMemoryEntry {
  id: string;
  /** One sentence a later agent can act on without the chat it came from. */
  text: string;
  /** The screen, component or area it applies to; null = the whole app. */
  area: string | null;
  /** The human's own request, or something an agent decided while building. */
  source: 'human' | 'agent';
  sessionId: string | null;
  at: string;
}

const MEMORY_PATH = process.env.HARNESS_DESIGN_MEMORY_PATH ?? path.join(config.harnessRoot, 'backend', 'local-design-memory.json');
const MAX_ENTRIES = 80;

type Store = Record<string, DesignMemoryEntry[]>;

function readStore(): Store {
  try {
    return JSON.parse(readFileSync(MEMORY_PATH, 'utf8')) as Store;
  } catch {
    return {};
  }
}

function writeStore(store: Store): void {
  if (!existsSync(path.dirname(MEMORY_PATH))) mkdirSync(path.dirname(MEMORY_PATH), { recursive: true });
  writeFileSync(MEMORY_PATH, JSON.stringify(store, null, 2), 'utf8');
}

export function listDesignMemory(appId: string): DesignMemoryEntry[] {
  return readStore()[appId] ?? [];
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

export interface DesignMemoryChange {
  add?: { text: string; area?: string | null; source: 'human' | 'agent' }[];
  /** Entries that replace an earlier one: the old id goes, the new text takes its place. */
  replace?: { id: string; text: string; area?: string | null }[];
  remove?: string[];
}

/** Applies a change and returns the entries as they now stand. Exact repeats are not added twice. */
export function changeDesignMemory(appId: string, sessionId: string | null, change: DesignMemoryChange): DesignMemoryEntry[] {
  const store = readStore();
  let entries = [...(store[appId] ?? [])];
  const at = new Date().toISOString();
  const drop = new Set(change.remove ?? []);
  entries = entries.filter((e) => !drop.has(e.id));
  for (const r of change.replace ?? []) {
    const i = entries.findIndex((e) => e.id === r.id);
    if (i < 0) continue;
    entries[i] = { ...entries[i], text: r.text.trim(), area: r.area === undefined ? entries[i].area : r.area?.trim() || null, at };
  }
  for (const a of change.add ?? []) {
    const text = a.text.trim();
    if (!text || entries.some((e) => norm(e.text) === norm(text))) continue;
    entries.push({ id: randomUUID().slice(0, 8), text, area: a.area?.trim() || null, source: a.source, sessionId, at });
  }
  // Oldest agent-made entries go first if the list outgrows what an agent should carry.
  while (entries.length > MAX_ENTRIES) {
    const i = entries.findIndex((e) => e.source === 'agent');
    entries.splice(i < 0 ? 0 : i, 1);
  }
  writeStore({ ...store, [appId]: entries });
  return entries;
}

export function designMemoryFingerprint(appId: string): string {
  const entries = listDesignMemory(appId);
  if (!entries.length) return 'none';
  return createHash('sha1').update(entries.map((e) => `${e.id}:${e.text}:${e.area}`).join('\n')).digest('hex').slice(0, 12);
}

export type DesignMemoryRole = 'uiux' | 'plan' | 'coding' | 'qa';

const BY_ROLE: Record<DesignMemoryRole, string> = {
  uiux:
    'Start from this list. Do not undo, restyle or "improve away" anything in it, even when it looks off to you; the human asked ' +
    'for it. If you think one is a mistake, say so in the requirements and ask, and only change it once the human agrees. ' +
    'When the human asks for something about the look in this chat, record it with remember_design before you finish ' +
    'the turn, in words a later pass can follow without this chat. Record what you decide too (source agent), so the next ' +
    'pass builds on it. When a new request replaces an entry, replace it; when the human withdraws one, remove it. Write ' +
    'the plan so no step contradicts an entry.',
  plan: 'No plan step may contradict an entry. If the work has to, say so in the plan and flag it for the human.',
  coding:
    'Leave every entry in force: when you restyle or move a UI element, keep what the entries say about it. Before you ' +
    'finish, check the files you changed against the entries for those areas. When the human tells you something about the ' +
    'look in this chat, record it with remember_design.',
  qa:
    'Check the diff against every entry for the areas it touches. A change that undoes or contradicts an entry is a finding ' +
    '(a blocker unless the requirements say the human asked for the change).',
};

/** The remembered decisions as a system-prompt section for a role, or '' when there are none. */
export function designMemoryBriefing(appId: string | null | undefined, role: DesignMemoryRole): string {
  if (!appId) return '';
  const entries = listDesignMemory(appId);
  if (!entries.length) return '';
  const lines = entries
    .map((e) => `- [${e.id}] ${e.area ? `(${e.area}) ` : ''}${e.text}${e.source === 'human' ? ' — asked by the human' : ''}`)
    .join('\n');
  return (
    `\n\n# Design decisions to keep (remembered across sessions and passes)\n\n` +
    `Earlier passes and sessions settled these about how this app looks and behaves. They outrank your own taste and any ` +
    `general style guidance.\n\n${lines}\n\n${BY_ROLE[role]}`
  );
}
