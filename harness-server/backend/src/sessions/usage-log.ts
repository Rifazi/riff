import { promises as fs } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import type { TokenUsage, ToolOutputStats } from '../agents/sdk-client.js';
import type { HelperName } from './session.js';

// One line per agent turn's token usage, so usage can be shown over time
// (Settings → Dev Agents → Token usage, routes/usage.ts). A session's own
// `usage` keeps only running totals per stage. Kept under state/: local,
// disposable, and outlives a deleted session on purpose — its tokens were
// still spent.

export type UsageStage = 'requirements' | 'plan' | 'coding' | 'qa';

export interface UsageLogEntry {
  at: string;
  sessionId: string;
  stage: UsageStage;
  usage: TokenUsage;
  // Absent on entries from before tool output was tracked.
  toolOutput?: ToolOutputStats;
  // Set on a local helper run's entry (agents/helpers/helper.ts): `usage`
  // is then the helper's local tokens, which cost nothing and are kept out
  // of the paid totals and of the session's own `usage`.
  helper?: {
    name: HelperName;
    tasks: number;
    useful: number;
    // Paid-context tokens the run avoided (0 where not estimated).
    savedTokens: number;
    // A correction, not a run: the paid agent redid an earlier run's work,
    // so `useful` and `savedTokens` are negative and cancel that run's.
    redo?: true;
  };
}

const LOG_PATH = path.join(config.stateDir, 'usage-log.jsonl');

export async function appendUsageLog(entry: UsageLogEntry): Promise<void> {
  try {
    await fs.mkdir(config.stateDir, { recursive: true });
    await fs.appendFile(LOG_PATH, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch (err) {
    console.warn('[usage] could not append to the usage log —', err instanceof Error ? err.message : err);
  }
}

export async function readUsageLog(): Promise<UsageLogEntry[]> {
  let raw: string;
  try {
    raw = await fs.readFile(LOG_PATH, 'utf8');
  } catch {
    return [];
  }
  const entries: UsageLogEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as UsageLogEntry);
    } catch {
      // a torn last line from a crash — skip it
    }
  }
  return entries;
}
