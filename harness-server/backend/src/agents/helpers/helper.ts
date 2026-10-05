import type { TranscriptEntry, HelperRunStats } from '../../sessions/session.js';
import { appendUsageLog, type UsageStage } from '../../sessions/usage-log.js';
import { appendTranscriptEntry } from '../../sessions/session-store.js';
import { ZERO_USAGE, type TokenUsage } from '../sdk-client.js';

export type { HelperName, HelperRunStats } from '../../sessions/session.js';

// Local helpers: work an agent hands to a model on this machine instead of
// doing it in its paid context. Each helper is a folder here with the same
// parts: `core.ts` (pure rules, unit-tested from frontend/tests/harness-server/),
// the runtime, and the tool the agents call (`tool.ts` for the AI-SDK
// engine, `tool-claude.ts` for the Claude engine).
//
//   research/    `delegate`: read-only research loops on the system Ollama
//   classifier/  `classify_text`: zero-shot labels from an on-device NLI model
//
// Every helper run is reported the same way, through reportHelperRun: one
// usage-log line (kept out of the paid totals; Settings → Dev Agents →
// Token usage shows them as "Saved by local helpers") and one chat entry,
// which the chat folds into that tool call's result card.

/** Where a helper run is reported: the session and stage it ran for, and how to add to that chat. */
export interface HelperContext {
  sessionId: string;
  stage: UsageStage;
  record: (entry: Omit<TranscriptEntry, 'id' | 'timestamp'>) => Promise<unknown>;
}

/**
 * Logs one helper run and records it in the chat. `summary` is the entry's
 * text, for anything that reads transcripts as text (handoff notes). Never
 * throws: reporting must not fail the tool call it describes.
 */
export async function reportHelperRun(
  context: HelperContext | undefined,
  stats: HelperRunStats,
  summary: string,
  usage: TokenUsage = ZERO_USAGE,
): Promise<void> {
  if (!context) return;
  try {
    await appendUsageLog({
      at: new Date().toISOString(),
      sessionId: context.sessionId,
      stage: context.stage,
      usage,
      helper: { name: stats.helper, tasks: stats.tasks, useful: stats.useful, savedTokens: stats.savedTokens ?? 0 },
    });
    await context.record({ role: 'system', text: summary, helper: stats });
  } catch (err) {
    console.warn(`[helpers] could not report a ${stats.helper} run —`, err instanceof Error ? err.message : err);
  }
}

/** A context that records into one stage's own chat (the single agent's; team members record into theirs). */
export function stageHelperContext(sessionId: string, stage: UsageStage): HelperContext {
  return { sessionId, stage, record: (entry) => appendTranscriptEntry(sessionId, stage, entry) };
}
