import { generateText } from 'ai';
import type { TranscriptEntry } from '../sessions/session.js';
import type { ApiKeyProvider } from '../settings/settings.js';
import { getApiKey, getRoleModelConfig } from '../settings/settings-store.js';
import { getPromptOverride } from '../settings/prompts-store.js';
import { resolveLanguageModel, runClaudeSingleShot } from './sdk-client.js';
import { generateLocal } from './local-llm.js';

export interface CoordinatorDecision {
  // ready: the stage's work is finished (Bridget then gates its approval).
  // blocked: the agent is waiting on something only a human can give.
  action: 'continue' | 'ready' | 'blocked';
  message?: string;
  reason: string;
}

// Deliberately tool-less: this decision only ever says "keep going", "this
// stage is finished" or "stop for a human" — it never writes a file, runs a
// command or approves anything. Approving a finished stage is a separate
// decision (decideGate below) that Bridget acts on in routes/coordinator.ts.
export const DECISION_INSTRUCTIONS = `You are a lightweight coordinator supervising one stage of a multi-stage AI development pipeline (requirements -> plan -> coding -> QA) for a target repo. You do not write files, run commands, or approve anything yourself — you only decide, given the conversation so far, whether the stage's own agent should be sent another message to keep working, whether the stage's work is finished, or whether it needs a human.

Respond with ONLY a single JSON object, no other text, matching exactly one of these shapes:
{"action": "continue", "message": "<the next message to send the agent>", "reason": "<one sentence, why continue>"}
{"action": "ready", "reason": "<one sentence, why this stage's work is finished>"}
{"action": "blocked", "reason": "<one sentence, what the human needs to do>"}

Always "blocked" when the agent's last message is waiting on the human: it asks them a question, asks them to confirm, choose or review something, or says it is blocked on something only a human can do (credentials, a decision). Never answer on the human's behalf.

Not blocked: the agent couldn't find a file, search turned up nothing, a test setup or dependency is missing, or a command failed. The agent can fix those itself (search under other names, check the config, create what's missing), so answer "continue" with a message telling it to.

"ready" only when the agent has produced the stage's document, diff or report, says it is complete, and has nothing left it means to do. Say "blocked" if you have any doubt.

"continue" only when the agent has said what it will do next and nothing it needs is missing.`;

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
  const afterUser = entries.slice(lastUserIndex + 1);
  if (afterUser.some((e) => e.role === 'tool_call' && QUESTION_TOOL_NAMES.has(stripToolPrefix(e.toolName)))) return true;
  // Also a question asked in plain text in the agent's closing paragraph — the
  // decision model (especially the small local one) otherwise tends to
  // "continue" by answering it on the human's behalf.
  const lastText = [...afterUser].reverse().find((e) => e.role === 'assistant')?.text ?? '';
  return endsWithQuestion(lastText);
}

// Any question mark in the closing paragraph (outside inline code). A false
// positive only stops auto-driving for a human to look — the safe direction.
export function endsWithQuestion(text: string): boolean {
  const lastParagraph = text.trim().split(/\n\s*\n/).pop() ?? '';
  return lastParagraph.replace(/`[^`]*`/g, '').includes('?');
}

// "Continue or ready?" only needs recent activity, not the whole stage —
// which can include a pasted meeting transcript and dozens of turns.
const MAX_ENTRY_CHARS = 1500;
const MAX_TRANSCRIPT_CHARS = 12_000;

function clip(text: string | undefined): string {
  const t = text ?? '';
  return t.length > MAX_ENTRY_CHARS ? `${t.slice(0, MAX_ENTRY_CHARS)} […]` : t;
}

export function flattenTranscript(entries: TranscriptEntry[]): string {
  const lines = entries
    .map((e) => {
      if (e.role === 'user') return `HUMAN: ${clip(e.text)}`;
      if (e.role === 'assistant') return `AGENT: ${clip(e.text)}`;
      if (e.role === 'tool_call') return `[called ${e.toolName}]`;
      if (e.role === 'tool_result') return `[tool result${e.isError ? ' ERROR' : ''}: ${JSON.stringify(e.toolResult).slice(0, 300)}]`;
      return '';
    })
    .filter(Boolean);

  const kept: string[] = [];
  let total = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (total + lines[i].length > MAX_TRANSCRIPT_CHARS && kept.length > 0) break;
    kept.unshift(lines[i]);
    total += lines[i].length + 1;
  }
  if (kept.length < lines.length) kept.unshift(`[${lines.length - kept.length} earlier entries omitted]`);
  return kept.join('\n');
}

export function parseDecision(raw: string): CoordinatorDecision {
  return (
    tryParseDecision(raw) ?? {
      // Never loop on, or approve, something we can't parse — stop and let a human look.
      action: 'blocked',
      reason: "Could not parse a decision from the coordinator's response — stopping for a human to review.",
    }
  );
}

function tryParseDecision(raw: string): CoordinatorDecision | null {
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : raw) as Partial<CoordinatorDecision>;
    if (parsed.action === 'continue' && typeof parsed.message === 'string' && parsed.message.trim()) {
      return { action: 'continue', message: parsed.message, reason: String(parsed.reason ?? '') };
    }
    if (parsed.action === 'ready' || parsed.action === 'blocked') {
      return { action: parsed.action, reason: String(parsed.reason ?? '') };
    }
  } catch {
    // unparseable
  }
  return null;
}

export async function decideNextAction(params: {
  stageLabel: string;
  transcriptText: string;
  appId: string;
}): Promise<CoordinatorDecision> {
  const { stageLabel, transcriptText, appId } = params;
  const coordinatorConfig = await getRoleModelConfig('coordinator');
  const { provider, model } = coordinatorConfig;
  const override = await getPromptOverride(appId, 'coordinator');
  const systemPrompt = override ?? DECISION_INSTRUCTIONS;
  const prompt = `Stage: ${stageLabel}\n\nConversation so far:\n${transcriptText || '(nothing yet)'}\n\nDecide: continue, ready or blocked?`;

  // Riff's built-in local model first — free, and on the decision set in
  // CLAUDE.md step 12 it matched Haiku, with its misses all on the safe side
  // (stopping early). Anything wrong with it (not downloaded, helper
  // missing, timeout, unparseable reply) falls through to the configured
  // model below.
  if (coordinatorConfig.useLocalModel !== false) {
    try {
      const decision = tryParseDecision(await generateLocal({ system: systemPrompt, prompt }));
      if (decision) return decision;
    } catch (err) {
      console.warn('[coordinator] local model unavailable, using', model, '—', err instanceof Error ? err.message : err);
    }
  }

  if (provider === 'claude') {
    const raw = await runClaudeSingleShot({ systemPrompt, prompt, model });
    return parseDecision(raw);
  } else {
    const apiKey = await getApiKey(provider);
    if (apiKey === null) {
      return { action: 'blocked', reason: `No API key configured for ${provider} — stopping for a human to review.` };
    }
    const languageModel = await resolveLanguageModel(provider as ApiKeyProvider, model, apiKey);
    const { text } = await generateText({ model: languageModel, system: systemPrompt, prompt });
    return parseDecision(text);
  }
}

export interface GateDecision {
  action: 'approve' | 'stop';
  reason: string;
}

// Bridget approves a finished stage on the human's behalf only when nothing
// in it needs them. Stopping is always the safe answer.
export const GATE_INSTRUCTIONS = `You decide whether a finished stage of an AI development pipeline (requirements -> plan -> coding -> QA) can be approved without a human. The stage's agent has produced its deliverable (a requirements document, a plan, or a finished branch). You see the end of its conversation.

Respond with ONLY a single JSON object, no other text:
{"action": "approve", "reason": "<one sentence>"}
{"action": "stop", "reason": "<one sentence naming what needs the human>"}

"stop" when the agent's recent messages raise anything a human should decide or know before going on: an open question, an assumption it asks to have confirmed, a choice between options, a risk or concern, something it could not do or verify, failing or skipped checks (even ones it calls pre-existing, flaky or unrelated), a blocker, or work it says is incomplete.

"approve" when the agent simply reports what it produced. A closing courtesy that only asks for approval or feedback ("Let me know if you'd like changes", "Ready for your review", "Shall I proceed?") is not an open question.`;

function tryParseGate(raw: string): GateDecision | null {
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : raw) as Partial<GateDecision>;
    if (parsed.action === 'approve' || parsed.action === 'stop') return { action: parsed.action, reason: String(parsed.reason ?? '') };
  } catch {
    // unparseable
  }
  return null;
}

/**
 * Whether a finished stage can be approved without the human. Same models
 * as decideNextAction: the built-in Qwen first, then the coordinator's
 * configured model. Anything unclear stops.
 */
export async function decideGate(params: { stageLabel: string; transcriptText: string }): Promise<GateDecision> {
  const coordinatorConfig = await getRoleModelConfig('coordinator');
  const { provider, model } = coordinatorConfig;
  const prompt = `Stage: ${params.stageLabel}\n\nEnd of the conversation:\n${params.transcriptText || '(nothing)'}\n\nApprove or stop?`;
  const stop = (reason: string): GateDecision => ({ action: 'stop', reason });

  if (coordinatorConfig.useLocalModel !== false) {
    try {
      const decision = tryParseGate(await generateLocal({ system: GATE_INSTRUCTIONS, prompt, maxTokens: 120 }));
      if (decision) return decision;
    } catch (err) {
      console.warn('[coordinator] local model unavailable for the gate, using', model, '—', err instanceof Error ? err.message : err);
    }
  }
  try {
    if (provider === 'claude') {
      return tryParseGate(await runClaudeSingleShot({ systemPrompt: GATE_INSTRUCTIONS, prompt, model })) ?? stop("Couldn't tell whether this needs you.");
    }
    const apiKey = await getApiKey(provider);
    if (apiKey === null) return stop(`No API key configured for ${provider}.`);
    const languageModel = await resolveLanguageModel(provider as ApiKeyProvider, model, apiKey);
    const { text } = await generateText({ model: languageModel, system: GATE_INSTRUCTIONS, prompt });
    return tryParseGate(text) ?? stop("Couldn't tell whether this needs you.");
  } catch (err) {
    return stop(`Couldn't check whether this needs you (${err instanceof Error ? err.message : String(err)}).`);
  }
}

/** A question tool the agent called after the human's last message (the text "?" heuristic left out: the gate reads text). */
export function hasPendingQuestionTool(entries: TranscriptEntry[]): boolean {
  let lastUserIndex = -1;
  entries.forEach((e, i) => {
    if (e.role === 'user') lastUserIndex = i;
  });
  return entries.slice(lastUserIndex + 1).some((e) => e.role === 'tool_call' && QUESTION_TOOL_NAMES.has(stripToolPrefix(e.toolName)));
}

/**
 * Whether the latest lint/test result in a stage's chat failed: a
 * run_checked_command report, or finish_step saying its checks failed.
 * Checked without a model, since a failure the agent calls "pre-existing"
 * reads like a pass to a small one.
 */
export function latestChecksFailed(entries: TranscriptEntry[]): boolean {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.role !== 'tool_result') continue;
    const name = stripToolPrefix(e.toolName);
    if (name !== 'run_checked_command' && name !== 'finish_step') continue;
    const text = toolResultText(e.toolResult);
    if (name === 'finish_step') {
      if (/still in progress: (lint|test) failed/.test(text)) return true;
      if (/lint and tests passed/.test(text)) return false;
      continue;
    }
    return !/\bsucceeded\.$/.test(text.split('\n')[0].trim());
  }
  return false;
}

function toolResultText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (Array.isArray(result)) {
    return result.map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : '')).join('\n');
  }
  return JSON.stringify(result ?? '');
}

// Words in a coding agent's closing message that mean something may be
// wrong. Matched without a model: the small one approved "2 tests fail, they
// look pre-existing" every time. A false match only stops for the human.
const CONCERN_WORDS =
  /\b(fail(s|ed|ing|ure|ures)?|couldn'?t|could not|unable to|not (been )?(verified|tested)|untested|unverified|skipped|blocked|pre-?existing|flaky|workaround)\b/i;

const NEGATED_BEFORE = /\b(no|zero|0|without|none|never|nothing|neither|nor)\b[^.,;:!?\n]*$/i;
const RESOLVED_IN_SENTENCE = /\b(fixed|resolved|now (passes?|passing|green|succeeds?)|then (passes?|passed)|after (the )?fix(ing)?|previously|earlier|initially)\b/i;

function isBenignMention(text: string, index: number): boolean {
  const start = Math.max(text.lastIndexOf('.', index), text.lastIndexOf('\n', index), text.lastIndexOf('!', index), text.lastIndexOf('?', index)) + 1;
  const ends = ['.', '\n', '!', '?'].map((c) => text.indexOf(c, index)).filter((i) => i >= 0);
  const sentence = text.slice(start, ends.length ? Math.min(...ends) : text.length);
  if (NEGATED_BEFORE.test(text.slice(start, index))) return true;
  return RESOLVED_IN_SENTENCE.test(sentence) && !/\bstill\b/i.test(sentence);
}

/** The first worrying phrase in the agent's last message, or null. A negated ("no tests failed") or resolved ("fixed the failing test") mention doesn't count. */
export function concernInLastMessage(entries: TranscriptEntry[]): string | null {
  const last = [...entries].reverse().find((e) => e.role === 'assistant')?.text ?? '';
  const words = new RegExp(CONCERN_WORDS.source, 'gi');
  for (const m of last.matchAll(words)) {
    if (!isBenignMention(last, m.index ?? 0)) return m[0];
  }
  return null;
}

/** A concern the pre-QA lint and test run can confirm or clear, unlike "skipped" or "unverified". */
export function isFailureWord(word: string): boolean {
  return /^fail/i.test(word);
}
