import type { SessionRecord, TranscriptEntry } from './types';
import type { TurnOutcome } from './useAgentTurnStream';

// Mirrors hasUnansweredQuestion/endsWithQuestion in harness-server's
// agents/coordinator-agent.ts — the coordinator stops on the same signal.
const QUESTION_TOOL_NAMES = new Set(['ask_multiple_choice', 'ask_question']);

function stripToolPrefix(name: string | undefined): string {
  return (name ?? '').replace(/^mcp__[^_]+(-[^_]+)?__/, '');
}

function endsWithQuestion(text: string): boolean {
  const lastParagraph = text.trim().split(/\n\s*\n/).pop() ?? '';
  return lastParagraph.replace(/`[^`]*`/g, '').includes('?');
}

function hasUnansweredQuestion(entries: TranscriptEntry[]): boolean {
  let lastUserIndex = -1;
  entries.forEach((e, i) => {
    if (e.role === 'user') lastUserIndex = i;
  });
  const afterUser = entries.slice(lastUserIndex + 1);
  if (afterUser.some((e) => e.role === 'tool_call' && QUESTION_TOOL_NAMES.has(stripToolPrefix(e.toolName)))) return true;
  const lastText = [...afterUser].reverse().find((e) => e.role === 'assistant')?.text ?? '';
  return endsWithQuestion(lastText);
}

/** What auto-run compares before and after a turn to tell whether it moved. */
export interface AutoRunProgress {
  steps: string;
  commits: number;
}

export function progressOf(session: SessionRecord, commits: number): AutoRunProgress {
  return { steps: (session.codingPlan ?? []).map((s) => `${s.id}:${s.status}`).join(','), commits };
}

function clip(text: string, max = 300): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * Why auto-run can't go on after a turn, or null if it should send the next
 * "Continue". Anything that needs a human stops it: a failed turn (out of
 * tokens, usage limit, turn budget exhausted), a question for the human, or
 * a turn that neither advanced a checklist step nor committed anything —
 * sending "Continue" again would just repeat that turn.
 */
export function autoRunStopReason(
  turn: TurnOutcome,
  before: AutoRunProgress,
  after: AutoRunProgress,
  session: SessionRecord
): string | null {
  if (turn.error) return `the last turn failed — ${clip(turn.error)}`;
  if (turn.lastDone?.isError) {
    return turn.lastDone.text.trim() ? `the last turn ended with an error — ${clip(turn.lastDone.text)}` : 'the last turn ended with an error.';
  }
  if (hasUnansweredQuestion(session.transcripts.coding)) return 'the coding agent is waiting on an answer from you.';
  if (before.steps === after.steps && before.commits === after.commits) {
    return 'the last turn made no progress (no checklist step changed and nothing was committed). Check what the agent said, then reply or continue by hand.';
  }
  return null;
}
