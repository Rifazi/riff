import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tool, type ToolSet } from 'ai';
import { assertPathAllowed } from '../../../repo/guardrails.js';
import { fingerprint, searchIndex, syncScope, type SearchDocument } from '../../../search/search-engine.js';
import { generateLocal } from '../../local-llm.js';
import { reportHelperRedo, reportHelperRun, type HelperContext } from '../helper.js';
import { RedoLedger } from '../research/core.js';
import {
  entryChars,
  formatRecall,
  freshness,
  freshnessLabel,
  groundPicks,
  linesIn,
  normalizePath,
  NOT_IN_MEMORY,
  packCandidates,
  parseHeading,
  parseReadText,
  PICK_SYSTEM,
  pickPrompt,
  rankByTerms,
  recallDescription,
  recallSavedTokens,
  recallSchema,
  windows,
  type Candidate,
  type Excerpt,
  type MemoryEntry,
  type MemoryView,
  type RecallInput,
} from './core.js';
import { memoryEntries, memorySearchScope, recordRead, touchEntries } from './store.js';

export { MEMORY_NOTE } from './core.js';

// How many search hits a recall considers before packing them to the budget.
const SEARCH_HITS = 16;
const PICK_TOKENS = 120;

export interface ReadMemoryDeps {
  sessionId: string;
  // Whose checkout reads and recalls happen in: SESSION_VIEW, or a member's branch.
  view: MemoryView;
  repoRoot: string;
  // Who reads, for the record: "coding", or a workstream id.
  reader: string;
  context?: HelperContext;
  // Recalls that answered, and the files behind them, per agent turn: a
  // read_file of one afterwards cancels that recall's saving.
  ledger: RedoLedger;
}

/** The read memory's deps for an agent turn, or null when it's turned off in Settings. */
export function readMemoryDeps(params: Omit<ReadMemoryDeps, 'ledger'> & { enabled: boolean }): ReadMemoryDeps | null {
  if (!params.enabled) return null;
  const { enabled: _enabled, ...deps } = params;
  return { ...deps, ledger: new RedoLedger() };
}

/** Records a read in memory (the helpers' reads too). */
export function rememberRead(deps: ReadMemoryDeps | null, filePath: string, read: { text: string; fileHash: string }): void {
  if (!deps) return;
  const { start, lines } = parseReadText(read.text);
  void recordRead(deps.sessionId, { view: deps.view, path: filePath, fileHash: read.fileHash, start, lines, reader: deps.reader });
}

/** A paid read: remembered, and it cancels the saving of a recall it redoes. */
export function notePaidRead(deps: ReadMemoryDeps | null, filePath: string, read: { text: string; fileHash: string }): void {
  if (!deps) return;
  rememberRead(deps, filePath, read);
  for (const redo of deps.ledger.noteRead(filePath)) {
    void reportHelperRedo(deps.context, 'memory', redo.useful, redo.savedTokens);
  }
}

function searchDocuments(entries: Map<string, MemoryEntry>): SearchDocument[] {
  return [...entries].map(([key, entry]) => ({
    key,
    kind: 'read',
    title: entry.path,
    fingerprint: fingerprint(`${entry.fileHash}\u0000${entry.lines.length}\u0000${entry.lines[0]?.[0]}\u0000${entry.lines.at(-1)?.[0]}`),
    segments: windows(entry).map((w) => ({ heading: w.heading, text: w.text })),
  }));
}

/** Search-ranked windows, or a keyword ranking when the engine isn't available. */
async function rankedCandidates(deps: ReadMemoryDeps, question: string, entries: Map<string, MemoryEntry>): Promise<Candidate[]> {
  try {
    const scope = memorySearchScope(deps.sessionId);
    await syncScope(scope, searchDocuments(entries));
    const hits = await searchIndex({ text: question, scopes: [scope], kinds: ['read'], limit: SEARCH_HITS });
    const ranked: Candidate[] = [];
    for (const hit of hits) {
      const entry = entries.get(hit.key);
      const where = parseHeading(hit.heading);
      if (entry && where) ranked.push({ key: hit.key, path: entry.path, view: entry.view, start: where.start, end: where.end });
    }
    return ranked;
  } catch {
    return rankByTerms(question, [...entries.values()]);
  }
}

async function currentHash(repoRoot: string, filePath: string): Promise<string | null> {
  try {
    const content = await fs.readFile(assertPathAllowed(filePath, ['.'], repoRoot), 'utf8');
    return createHash('sha1').update(content).digest('hex');
  } catch {
    return null;
  }
}

export function createRecallExecute(deps: ReadMemoryDeps) {
  return async ({ question, paths }: RecallInput): Promise<string> => {
    const all = await memoryEntries(deps.sessionId);
    const scope = (paths ?? []).map(normalizePath).filter(Boolean);
    const inScope = (p: string) => scope.length === 0 || scope.some((s) => p === s || p.startsWith(`${s}/`));
    const entries = new Map([...all].filter(([, e]) => inScope(e.path)));
    if (entries.size === 0) {
      await reportHelperRun(deps.context, { helper: 'memory', model: 'none', tasks: 1, useful: 0, savedTokens: 0 }, NOT_IN_MEMORY);
      return NOT_IN_MEMORY;
    }

    const candidates = packCandidates(await rankedCandidates(deps, question, entries), entries);
    if (candidates.length === 0) {
      await reportHelperRun(deps.context, { helper: 'memory', model: 'none', tasks: 1, useful: 0, savedTokens: 0 }, NOT_IN_MEMORY);
      return NOT_IN_MEMORY;
    }

    // The local model only picks lines; without it, the best-ranked windows go back as they are.
    let excerpts: Excerpt[] | null;
    let model = 'builtin';
    try {
      const answer = await generateLocal({ system: PICK_SYSTEM, prompt: pickPrompt(question, candidates, entries), maxTokens: PICK_TOKENS });
      excerpts = /\bNONE\b/.test(answer) && !/\d/.test(answer) ? null : groundPicks(answer, candidates, entries);
    } catch {
      model = 'none';
      excerpts = candidates.slice(0, 3).map((c) => ({ ...c }));
    }
    if (!excerpts) {
      await reportHelperRun(deps.context, { helper: 'memory', model, tasks: 1, useful: 0, savedTokens: 0 }, NOT_IN_MEMORY);
      return NOT_IN_MEMORY;
    }

    const hashes = new Map<string, string | null>();
    const shown: { excerpt: Excerpt; lines: [number, string][]; label: string }[] = [];
    for (const excerpt of excerpts) {
      const entry = entries.get(excerpt.key)!;
      if (!hashes.has(entry.path)) hashes.set(entry.path, await currentHash(deps.repoRoot, entry.path));
      const label = freshnessLabel(freshness(entry, deps.view, hashes.get(entry.path)!), `${excerpt.path}:${excerpt.start}-${excerpt.end}`);
      shown.push({ excerpt, lines: linesIn(entry, excerpt.start, excerpt.end), label });
    }
    const text = formatRecall(shown);
    const keys = [...new Set(excerpts.map((e) => e.key))];
    const recalled = [...new Set(excerpts.map((e) => e.path))];
    const saved = recallSavedTokens(keys.map((k) => entryChars(entries.get(k)!)), text.length);
    await touchEntries(deps.sessionId, keys);
    deps.ledger.record(recalled, 1, saved);
    await reportHelperRun(
      deps.context,
      { helper: 'memory', model, tasks: 1, useful: 1, returnedChars: text.length, savedTokens: saved },
      `Read memory: recalled ${recalled.join(', ')} · saved ≈${saved} paid tokens`,
    );
    return text;
  };
}

export function createRecallTool(deps: ReadMemoryDeps) {
  return tool({ description: recallDescription, inputSchema: recallSchema, execute: createRecallExecute(deps) });
}

/**
 * The AI-SDK `recall` entry for a tool set. With the memory turned off, a
 * history that still has recall calls keeps a refusing stub so replays stay
 * valid (like delegateToolEntry).
 */
export function recallToolEntry(deps: ReadMemoryDeps | null, history: unknown[]): ToolSet {
  if (deps) return { recall: createRecallTool(deps) };
  if (!JSON.stringify(history).includes('"toolName":"recall"')) return {};
  return {
    recall: tool({
      description: recallDescription,
      inputSchema: recallSchema,
      execute: async () => 'The read memory is turned off in Settings. Use read_file.',
    }),
  };
}
