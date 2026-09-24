import { generateText } from 'ai';
import type { TranscriptEntry } from '../sessions/session.js';
import type { ApiKeyProvider } from '../settings/settings.js';
import { getCredential, getRoleModelConfig } from '../settings/settings-store.js';
import { getPromptOverride } from '../settings/prompts-store.js';
import { resolveLanguageModel, runClaudeSingleShot } from './sdk-client.js';

export interface CoordinatorDecision {
  action: 'continue' | 'ready';
  message?: string;
  reason: string;
}

// Deliberately tool-less: the coordinator only ever decides "keep going" or
// "stop for a human" — it never writes a file, runs a command, or (most
// importantly) approves/rejects anything itself. Every actual approval
// stays a human click, same rule as everywhere else in this app.
export const DECISION_INSTRUCTIONS = `You are a lightweight coordinator supervising one stage of a multi-stage AI development pipeline (requirements -> plan -> coding -> QA) for a target repo. You do not write files, run commands, or approve anything yourself — you only decide, given the conversation so far, whether the stage's own agent should be sent another message to keep working, or whether the work looks ready for a human to review and approve.

Respond with ONLY a single JSON object, no other text, matching exactly one of these shapes:
{"action": "continue", "message": "<the next message to send the agent>", "reason": "<one sentence, why continue>"}
{"action": "ready", "reason": "<one sentence, why this looks ready for human review>"}

Prefer "ready" once the agent has produced a document/diff and stopped to summarize rather than looping it indefinitely — the point is to save the human typing "continue" a few times, not to run unattended forever.`;

// Mirrors ChatPane.tsx's QUESTION_TOOL_NAMES/stripToolPrefix/pendingQuestions
// logic on the frontend — duplicated rather than shared for the same reason
// stage-group.ts is (see its own comment): the two projects don't share a
// package. flattenTranscript below renders a tool_call as just
// `[called ask_multiple_choice]`, with no question/options text at all, so
// the LLM coordinator has no way to tell a pending, unanswered question
// apart from a routine tool call — it would just see "conversation
// stopped" and guess "continue" is safe, composing a pointless check-in
// message and re-prompting the stage's agent instead of actually waiting.
// This check runs before the LLM is even asked, so that failure mode is
// structurally impossible rather than something the prompt has to get
// right.
const QUESTION_TOOL_NAMES = new Set(['ask_multiple_choice', 'ask_question']);

function stripToolPrefix(name: string | undefined): string {
  return (name ?? '').replace(/^mcp__[^_]+(-[^_]+)?__/, '');
}

export function hasUnansweredQuestion(entries: TranscriptEntry[]): boolean {
  let lastUserIndex = -1;
  entries.forEach((e, i) => {
    if (e.role === 'user') lastUserIndex = i;
  });
  return entries.some(
    (e, i) => i > lastUserIndex && e.role === 'tool_call' && QUESTION_TOOL_NAMES.has(stripToolPrefix(e.toolName))
  );
}

export function flattenTranscript(entries: TranscriptEntry[]): string {
  return entries
    .map((e) => {
      if (e.role === 'user') return `HUMAN: ${e.text}`;
      if (e.role === 'assistant') return `AGENT: ${e.text}`;
      if (e.role === 'tool_call') return `[called ${e.toolName}]`;
      if (e.role === 'tool_result') return `[tool result${e.isError ? ' ERROR' : ''}: ${JSON.stringify(e.toolResult).slice(0, 300)}]`;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function parseDecision(raw: string): CoordinatorDecision {
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : raw) as Partial<CoordinatorDecision>;
    if (parsed.action === 'continue' && typeof parsed.message === 'string' && parsed.message.trim()) {
      return { action: 'continue', message: parsed.message, reason: String(parsed.reason ?? '') };
    }
    if (parsed.action === 'ready') {
      return { action: 'ready', reason: String(parsed.reason ?? '') };
    }
  } catch {
    // fall through to the fail-safe below
  }
  // Never loop on something we can't parse — stop and let a human look.
  return { action: 'ready', reason: "Could not parse a decision from the coordinator's response — stopping for a human to review." };
}

export async function decideNextAction(params: {
  stageLabel: string;
  transcriptText: string;
  appId: string;
}): Promise<CoordinatorDecision> {
  const { stageLabel, transcriptText, appId } = params;
  const { provider, model } = await getRoleModelConfig('coordinator');
  const override = await getPromptOverride(appId, 'coordinator');
  const systemPrompt = override ?? DECISION_INSTRUCTIONS;
  const prompt = `Stage: ${stageLabel}\n\nConversation so far:\n${transcriptText || '(nothing yet)'}\n\nDecide: continue or ready?`;

  if (provider === 'claude') {
    const raw = await runClaudeSingleShot({ systemPrompt, prompt, model });
    return parseDecision(raw);
  } else {
    const apiKey = await getCredential(provider);
    if (!apiKey) {
      return { action: 'ready', reason: `No API key configured for ${provider} — stopping for a human to review.` };
    }
    const languageModel = resolveLanguageModel(provider as ApiKeyProvider, model, apiKey);
    const { text } = await generateText({ model: languageModel, system: systemPrompt, prompt });
    return parseDecision(text);
  }
}
