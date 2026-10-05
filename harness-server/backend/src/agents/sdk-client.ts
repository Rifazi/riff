import { streamText, stepCountIs, generateText, type ModelMessage, type ToolSet, type LanguageModel } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogle } from '@ai-sdk/google';
import { query, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import type { ApiKeyProvider } from '../settings/settings.js';
import { ollamaEndpoint, openAICompatBase } from '../settings/ollama.js';

const DEFAULT_TEST_MODEL: Record<ApiKeyProvider, string> = {
  anthropic: 'claude-haiku-4-5',
  openai: 'gpt-4o-mini',
  google: 'gemini-2.0-flash',
  // Never used: ollama is tested against its installed-model list instead
  // (routes/settings.ts → settings/ollama.ts's testOllama).
  ollama: '',
};

export async function resolveLanguageModel(provider: ApiKeyProvider, model: string, apiKey: string): Promise<LanguageModel> {
  switch (provider) {
    case 'anthropic':
      return createAnthropic({ apiKey })(model);
    case 'openai':
      return createOpenAI({ apiKey })(model);
    case 'google':
      return createGoogle({ apiKey })(model);
    case 'ollama': {
      // The system Ollama's OpenAI-compatible API (<endpoint>/v1/chat/
      // completions): native tool calling on whatever model is installed
      // there, no auth — the key is only the placeholder the API shape wants.
      const baseURL = openAICompatBase(await ollamaEndpoint());
      return createOpenAI({ baseURL, apiKey: apiKey || 'ollama', name: 'ollama' }).chat(model);
    }
    default: {
      const exhaustive: never = provider;
      throw new Error(`Unknown provider: ${String(exhaustive)}`);
    }
  }
}

// Note: for the "ollama" provider, test the endpoint instead (settings/ollama.ts's
// testOllama) — see routes/settings.ts.
export async function testProviderCredential(provider: ApiKeyProvider, apiKey: string, model?: string): Promise<void> {
  const languageModel = await resolveLanguageModel(provider, model || DEFAULT_TEST_MODEL[provider], apiKey);
  await generateText({ model: languageModel, prompt: 'Reply with just "ok".', maxOutputTokens: 5 });
}

// Tokens for one agent turn, summed across its continuation hops. `input`
// is uncached input only, so the four fields add up to the whole bill.
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const ZERO_USAGE: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  };
}

// Characters of tool output a turn fed back to the model, per tool — to see
// which tools the context goes to (Settings → Dev Agents → Token usage).
export type ToolOutputStats = Record<string, { calls: number; chars: number }>;

const MCP_TOOL_PREFIX_RE = /^mcp__.*?__/;

/** Wraps onEvent to count each tool result's size under its tool's name. */
function trackToolOutput(onEvent: (event: AgentEvent) => void) {
  const names = new Map<string, string>();
  const stats: ToolOutputStats = {};
  const tracked = (event: AgentEvent) => {
    if (event.type === 'tool_call') names.set(event.toolCallId, event.name.replace(MCP_TOOL_PREFIX_RE, ''));
    if (event.type === 'tool_result') {
      const name = names.get(event.toolCallId) ?? 'unknown';
      const chars = typeof event.content === 'string' ? event.content.length : (JSON.stringify(event.content) ?? '').length;
      const s = (stats[name] ??= { calls: 0, chars: 0 });
      s.calls += 1;
      s.chars += chars;
    }
    onEvent(event);
  };
  return { tracked, stats };
}

export type AgentEvent =
  | { type: 'assistant_text'; text: string }
  | { type: 'tool_call'; toolCallId: string; name: string; input: unknown }
  | { type: 'tool_result'; toolCallId: string; content: unknown; isError: boolean }
  | { type: 'done'; text: string; isError: boolean }
  | { type: 'error'; message: string }
  | { type: 'coordinator_decision'; action: 'continue' | 'ready'; reason: string }
  | { type: 'continuation'; hop: number; maxHops: number }
  | { type: 'compacted'; contextTokens: number }
  | { type: 'usage'; usage: TokenUsage; toolOutput?: ToolOutputStats };

// Bounds automatic continuation (see runAgentTurn/runClaudeAgentTurn below):
// when a turn is cut off purely because it hit its own per-call step/turn
// budget — not a real error — the wrapper transparently starts a fresh call
// with a fresh budget, resuming the same underlying conversation rather than
// replaying it. Capped so a confused agent can't spin indefinitely; worst
// case per human message becomes (1 + this) * the per-call budget.
const MAX_CONTINUATION_HOPS = 3;
// How runAgentTurn's result text starts when the turn ran out of hops.
export const OUT_OF_STEPS = 'This step needed more tool calls than';
const CONTINUATION_PROMPT =
  "You were stopped only because this turn reached its tool-call budget — you have NOT finished and this is " +
  "not an error to report. Continue exactly where you left off: do not restate progress, do not repeat " +
  "completed writes/commits/tool calls, just proceed with the remaining work.";
const CONTINUATION_AFTER_COMPACTION_PROMPT =
  "You were stopped only because the previous conversation reached its tool-call budget — the work is NOT " +
  "finished. Continue from the state above: don't redo anything already committed or listed as done, just " +
  "proceed with the remaining work.";

// Context compaction at a continuation hop: a context at or over `atTokens`
// isn't resumed — the next hop starts a fresh conversation that opens with
// `handoff()` (agents/handoff.ts) instead. Every later step of a resumed
// context re-reads all of it, so this bounds what one long turn can cost.
// `systemPrompt`, when returned, replaces the turn's own for the fresh
// conversation — a resumed turn's system prompt can be the short form that
// leaves out what the conversation's first turn already carried.
export interface CompactionOptions {
  atTokens: number;
  handoff: () => Promise<{ prompt: string; systemPrompt?: string }>;
  // Tool-call steps per hop and the number of hops, in place of the
  // defaults (20 and MAX_CONTINUATION_HOPS). Compaction is only checked
  // between hops, so shorter hops let it act before the context gets
  // large; the coding agents use 10 × 6, which keeps the same total.
  stepsPerHop?: number;
  maxHops?: number;
}

export interface RunAgentTurnParams {
  systemPrompt: string;
  tools: ToolSet;
  provider: ApiKeyProvider;
  model: string;
  apiKey: string;
  history: ModelMessage[];
  prompt: string;
  onEvent: (event: AgentEvent) => void;
  compaction?: CompactionOptions;
  // Cancels the model calls, e.g. a delegate helper's time limit.
  abortSignal?: AbortSignal;
}

export interface RunAgentTurnResult {
  updatedHistory: ModelMessage[];
  resultText: string;
  isError: boolean;
  usage: TokenUsage;
  // The prompt size of the turn's last model call — what the next step of
  // this conversation would re-send. Callers use it to decide whether to
  // start their next turn in a fresh conversation.
  contextTokens: number;
}

// Compaction only pays off when the conversation has grown well past where
// it started: a context that begins near atTokens (long approved docs)
// would otherwise be compacted, at the cost of a handoff, after every hop.
const MIN_GROWTH_TO_COMPACT = 20_000;

function shouldCompact(compaction: CompactionOptions | undefined, contextTokens: number, startTokens: number): boolean {
  return Boolean(compaction) && contextTokens >= compaction!.atTokens && contextTokens - startTokens >= MIN_GROWTH_TO_COMPACT;
}

interface RunAgentTurnOnceResult extends RunAgentTurnResult {
  // 'tool-calls' means stopWhen cut the step loop off while the model still
  // wanted to act — as opposed to 'stop', a genuine finish — which is the
  // signal the wrapper below uses to decide whether to auto-continue. Null
  // if the call threw before a finish reason was ever produced.
  finishReason: string | null;
  // The prompt size of this call's first model request.
  startTokens: number;
}

/**
 * Runs a single streamText call, capped at 20 tool-call steps. The security
 * boundary here is simply which tools are in the `tools` object passed in —
 * unlike the previous Claude-Code-CLI-based engine there's no separate
 * built-in tool set to disable: the model can only ever call what's in that
 * object, full stop.
 */
async function runAgentTurnOnce(params: RunAgentTurnParams): Promise<RunAgentTurnOnceResult> {
  const { systemPrompt, tools, provider, model, apiKey, history, prompt, onEvent } = params;
  const steps = params.compaction?.stepsPerHop ?? 20;

  let fullText = '';
  let sawError = false;
  const textBuffers = new Map<string, string>();

  try {
    const languageModel = await resolveLanguageModel(provider, model, apiKey);

    // Anthropic only caches what's marked: the system prompt (with the
    // tools ahead of it) and the prior-turn history. Without this, every
    // step of every turn re-bills all of it at the full input rate. The
    // Claude-login engine gets this from Claude Code already.
    const cache = provider === 'anthropic' ? { anthropic: { cacheControl: { type: 'ephemeral' as const } } } : undefined;
    const messages: ModelMessage[] = [...history, { role: 'user', content: prompt }];
    if (cache && history.length > 0) {
      const last = history.length - 1;
      messages[last] = { ...messages[last], providerOptions: { ...messages[last].providerOptions, ...cache } };
    }

    const result = streamText({
      model: languageModel,
      instructions: cache ? { role: 'system', content: systemPrompt, providerOptions: cache } : systemPrompt,
      tools,
      messages,
      stopWhen: stepCountIs(steps),
      abortSignal: params.abortSignal,
    });

    for await (const part of result.stream) {
      switch (part.type) {
        case 'text-delta': {
          const prev = textBuffers.get(part.id) ?? '';
          textBuffers.set(part.id, prev + part.text);
          break;
        }
        case 'text-end': {
          const text = textBuffers.get(part.id) ?? '';
          if (text) {
            fullText += (fullText ? '\n\n' : '') + text;
            onEvent({ type: 'assistant_text', text });
          }
          break;
        }
        case 'tool-call': {
          onEvent({ type: 'tool_call', toolCallId: part.toolCallId, name: part.toolName, input: part.input });
          break;
        }
        case 'tool-result': {
          onEvent({ type: 'tool_result', toolCallId: part.toolCallId, content: part.output, isError: false });
          break;
        }
        case 'tool-error': {
          sawError = true;
          const message = part.error instanceof Error ? part.error.message : String(part.error);
          onEvent({ type: 'tool_result', toolCallId: part.toolCallId, content: message, isError: true });
          break;
        }
        case 'error': {
          sawError = true;
          const message = part.error instanceof Error ? part.error.message : String(part.error);
          onEvent({ type: 'error', message });
          break;
        }
        default:
          break;
      }
    }

    const responseMessages = await result.responseMessages;
    const updatedHistory: ModelMessage[] = [...history, { role: 'user', content: prompt }, ...responseMessages];
    const finishReason = await result.finishReason;
    const allSteps = await result.steps;
    const contextTokens = allSteps.at(-1)?.usage.inputTokens ?? 0;
    const startTokens = allSteps[0]?.usage.inputTokens ?? 0;
    const total = await result.totalUsage;
    const cacheRead = total.inputTokenDetails?.cacheReadTokens ?? 0;
    const cacheWrite = total.inputTokenDetails?.cacheWriteTokens ?? 0;
    const usage: TokenUsage = {
      input: total.inputTokenDetails?.noCacheTokens ?? Math.max(0, (total.inputTokens ?? 0) - cacheRead - cacheWrite),
      output: total.outputTokens ?? 0,
      cacheRead,
      cacheWrite,
    };

    onEvent({ type: 'done', text: fullText, isError: sawError });
    return { updatedHistory, resultText: fullText, isError: sawError, finishReason, usage, contextTokens, startTokens };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onEvent({ type: 'error', message });
    return { updatedHistory: history, resultText: message, isError: true, finishReason: null, usage: ZERO_USAGE, contextTokens: 0, startTokens: 0 };
  }
}

/**
 * Wraps runAgentTurnOnce with automatic continuation: if a call is cut off
 * purely because it exhausted its 20-step budget (finishReason 'tool-calls'
 * rather than a genuine 'stop'), transparently re-invokes with the
 * accumulated history plus a short internal nudge, up to
 * MAX_CONTINUATION_HOPS times, instead of surfacing that as a dead end.
 */
export async function runAgentTurn(rawParams: RunAgentTurnParams): Promise<RunAgentTurnResult> {
  const { tracked: onEvent, stats: toolOutput } = trackToolOutput(rawParams.onEvent);
  const params = { ...rawParams, onEvent };
  let hop = 0;
  let currentHistory = params.history;
  let currentPrompt = params.prompt;
  let systemPrompt = params.systemPrompt;
  let result = await runAgentTurnOnce({ ...params, history: currentHistory, prompt: currentPrompt });
  let usage = result.usage;
  let conversationStart = result.startTokens;
  const maxHops = params.compaction?.maxHops ?? MAX_CONTINUATION_HOPS;

  while (result.finishReason === 'tool-calls' && hop < maxHops) {
    hop += 1;
    onEvent({ type: 'continuation', hop, maxHops });
    const compacting = shouldCompact(params.compaction, result.contextTokens, conversationStart);
    if (compacting) {
      const handoff = await params.compaction!.handoff();
      onEvent({ type: 'compacted', contextTokens: result.contextTokens });
      systemPrompt = handoff.systemPrompt ?? systemPrompt;
      currentHistory = [];
      currentPrompt = `${handoff.prompt}\n\n---\n\n${CONTINUATION_AFTER_COMPACTION_PROMPT}`;
    } else {
      currentHistory = result.updatedHistory;
      currentPrompt = CONTINUATION_PROMPT;
    }
    result = await runAgentTurnOnce({ ...params, systemPrompt, history: currentHistory, prompt: currentPrompt });
    usage = addUsage(usage, result.usage);
    if (compacting) conversationStart = result.startTokens;
  }
  onEvent({ type: 'usage', usage, toolOutput });

  if (result.finishReason === 'tool-calls' && hop >= maxHops) {
    return {
      updatedHistory: result.updatedHistory,
      resultText: `${OUT_OF_STEPS} ${maxHops} continuation rounds could cover — consider splitting the plan/checklist step further.`,
      isError: true,
      usage,
      contextTokens: result.contextTokens,
    };
  }

  return {
    updatedHistory: result.updatedHistory,
    resultText: result.resultText,
    isError: result.isError,
    usage,
    contextTokens: result.contextTokens,
  };
}

// --- Claude subscription (OAuth login) engine ---------------------------
//
// The "claude" provider doesn't take an API key at all: it spawns the
// bundled Claude Code CLI, which reads whatever credentials `claude login`
// already established on this machine (a Pro/Max subscription, billed
// against that plan's usage rather than pay-per-token API billing). Tools
// are exposed via an in-process MCP server instead of the plain `tools`
// object the AI-SDK engine above uses — same underlying execute functions
// (see tool-defs-claude/*.ts), different wire format. Conversation
// continuity here is the SDK's own `resume: sessionId`, not a replayed
// message array.

const CLAUDE_MCP_SERVER_NAME = 'harness-tools';

// Left to its defaults, each query() boots a Claude Code instance with this
// machine's whole setup — ~/.claude settings and plugins, skills, user and
// claude.ai MCP connectors — none of which an agent here can call (tools
// are [] and allowedTools names only harness-tools), but all of which can
// ride along in context on every call. 'project' is off too: it loaded the
// target repo's whole CLAUDE.md into every request; agents get its headings
// instead and read sections with read_doc (agents/repo-instructions.ts).
const CLAUDE_ISOLATION = {
  settingSources: [] as ('user' | 'project' | 'local')[],
  strictMcpConfig: true,
  skills: [] as string[],
};

export interface RunClaudeAgentTurnParams {
  systemPrompt: string;
  // A factory, not a pre-built server: each call to query() below connects
  // this to a fresh transport, and an MCP Server instance can only ever be
  // connected once — reusing the same built instance across a continuation
  // hop's new query() (see runClaudeAgentTurn) silently fails to (re)connect,
  // which hangs every subsequent tool call rather than erroring visibly.
  createMcpServer: () => McpSdkServerConfigWithInstance;
  toolNames: string[];
  model?: string;
  resumeSessionId: string | null;
  prompt: string;
  cwd: string;
  onEvent: (event: AgentEvent) => void;
  compaction?: CompactionOptions;
}

export interface RunClaudeAgentTurnResult {
  sdkSessionId: string | null;
  resultText: string;
  isError: boolean;
  usage: TokenUsage;
  // Same as RunAgentTurnResult.contextTokens.
  contextTokens: number;
}

interface RunClaudeAgentTurnOnceResult extends RunClaudeAgentTurnResult {
  // Same as RunAgentTurnOnceResult.startTokens.
  startTokens: number;
  // The raw `result` message's subtype ('success' | 'error_max_turns' |
  // 'error_during_execution' | ...) — null if the stream threw before any
  // `result` message arrived. The wrapper below only auto-continues on
  // 'error_max_turns' specifically, never on a genuine execution error.
  subtype: string | null;
}

// Caps agentic round-trips within one human turn — same ceiling as the
// AI-SDK engine's stepCountIs(20). Left unset, the SDK has no default cap,
// so a stage conversation with an ambiguous ask could quietly spin through
// dozens of tool calls (each one a full turn billed against Pro/Max usage)
// before ever returning to the human.
const MAX_TURNS_PER_STEP = 20;

async function runClaudeAgentTurnOnce(params: RunClaudeAgentTurnParams): Promise<RunClaudeAgentTurnOnceResult> {
  const { systemPrompt, createMcpServer, toolNames, model, resumeSessionId, prompt, cwd, onEvent } = params;
  const allowedTools = toolNames.map((n) => `mcp__${CLAUDE_MCP_SERVER_NAME}__${n}`);

  let sdkSessionId: string | null = resumeSessionId;
  let resultText = '';
  let isError = false;
  let subtype: string | null = null;
  let gotResult = false;
  let usage: TokenUsage = ZERO_USAGE;
  let contextTokens = 0;
  let startTokens = 0;

  const stream = query({
    prompt,
    options: {
      systemPrompt: { type: 'custom', prompt: systemPrompt },
      cwd,
      tools: [], // disable every built-in tool — only the MCP tools below are available
      mcpServers: { [CLAUDE_MCP_SERVER_NAME]: createMcpServer() },
      allowedTools,
      maxTurns: params.compaction?.stepsPerHop ?? MAX_TURNS_PER_STEP,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      permissionPrompts: 'none',
      ...CLAUDE_ISOLATION,
      ...(model ? { model } : {}),
      ...(resumeSessionId ? { resume: resumeSessionId } : {}),
    },
  });

  try {
    for await (const message of stream) {
      switch (message.type) {
        case 'system': {
          if (message.subtype === 'init') {
            sdkSessionId = message.session_id;
            // HARNESS_LOG_CONTEXT=1: log what fills the context window, e.g.
            // to confirm CLAUDE_ISOLATION leaves only harness-tools loaded.
            if (process.env.HARNESS_LOG_CONTEXT) {
              stream
                .getContextUsage({ detail: 'summary' })
                .then((u) => console.log('[context]', JSON.stringify(u.categories.map((c) => [c.name, c.tokens]))))
                .catch(() => {});
            }
          }
          break;
        }
        case 'assistant': {
          const u = message.message.usage;
          if (u) {
            contextTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
            if (!startTokens) startTokens = contextTokens;
          }
          for (const block of message.message.content) {
            if (block.type === 'text') {
              onEvent({ type: 'assistant_text', text: block.text });
            } else if (block.type === 'tool_use') {
              onEvent({ type: 'tool_call', toolCallId: block.id, name: block.name, input: block.input });
            }
          }
          break;
        }
        case 'user': {
          const content = message.message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'tool_result') {
                onEvent({
                  type: 'tool_result',
                  toolCallId: block.tool_use_id,
                  content: block.content,
                  isError: Boolean(block.is_error),
                });
              }
            }
          }
          break;
        }
        case 'result': {
          sdkSessionId = message.session_id;
          isError = message.is_error;
          subtype = message.subtype;
          resultText = message.subtype === 'success' ? message.result : message.errors.join('\n');
          // `usage`, not `modelUsage`/`total_cost_usd`: those carry a resumed
          // session's earlier totals forward, this is just this query() call.
          usage = {
            input: message.usage.input_tokens ?? 0,
            output: message.usage.output_tokens ?? 0,
            cacheRead: message.usage.cache_read_input_tokens ?? 0,
            cacheWrite: message.usage.cache_creation_input_tokens ?? 0,
          };
          gotResult = true;
          onEvent({ type: 'done', text: resultText, isError });
          break;
        }
        default:
          break;
      }
    }
  } catch (err) {
    // The CLI subprocess can exit non-zero right after emitting a terminal
    // `result` message (e.g. it treats hitting maxTurns as a fatal exit),
    // which makes the SDK's async generator throw on its own post-result
    // cleanup — after we've already parsed a perfectly good subtype/
    // resultText above. Don't let that throw clobber what `result` already
    // told us (in particular, this is what let 'error_max_turns' silently
    // turn into a raw, unretried error the human would see instead of the
    // continuation loop below picking it up).
    if (gotResult) {
      return { sdkSessionId, resultText, isError, subtype, usage, contextTokens, startTokens };
    }
    const message = err instanceof Error ? err.message : String(err);
    onEvent({ type: 'error', message });
    return { sdkSessionId, resultText: message, isError: true, subtype: null, usage, contextTokens, startTokens };
  }

  return { sdkSessionId, resultText, isError, subtype, usage, contextTokens, startTokens };
}

/**
 * Wraps runClaudeAgentTurnOnce with automatic continuation: if a call ends
 * in 'error_max_turns' (the SDK's own per-query() turn cap, not a real
 * failure) and a session id came back, transparently resumes that same
 * server-side session with a fresh turn budget instead of surfacing a dead
 * end — a genuinely new query()/CLI-subprocess instance that picks up right
 * where the last one stopped, no context replay needed. Any other error
 * subtype, or a thrown exception, returns immediately as before.
 */
export async function runClaudeAgentTurn(rawParams: RunClaudeAgentTurnParams): Promise<RunClaudeAgentTurnResult> {
  const { tracked: onEvent, stats: toolOutput } = trackToolOutput(rawParams.onEvent);
  const params = { ...rawParams, onEvent };
  let hop = 0;
  let systemPrompt = params.systemPrompt;
  let result = await runClaudeAgentTurnOnce(params);
  let usage = result.usage;
  let conversationStart = result.startTokens;
  const maxHops = params.compaction?.maxHops ?? MAX_CONTINUATION_HOPS;

  while (result.subtype === 'error_max_turns' && result.sdkSessionId && hop < maxHops) {
    hop += 1;
    onEvent({ type: 'continuation', hop, maxHops });
    if (shouldCompact(params.compaction, result.contextTokens, conversationStart)) {
      const handoff = await params.compaction!.handoff();
      onEvent({ type: 'compacted', contextTokens: result.contextTokens });
      systemPrompt = handoff.systemPrompt ?? systemPrompt;
      result = await runClaudeAgentTurnOnce({
        ...params,
        systemPrompt,
        resumeSessionId: null,
        prompt: `${handoff.prompt}\n\n---\n\n${CONTINUATION_AFTER_COMPACTION_PROMPT}`,
      });
      conversationStart = result.startTokens;
    } else {
      result = await runClaudeAgentTurnOnce({ ...params, systemPrompt, resumeSessionId: result.sdkSessionId, prompt: CONTINUATION_PROMPT });
    }
    usage = addUsage(usage, result.usage);
  }
  onEvent({ type: 'usage', usage, toolOutput });

  if (result.subtype === 'error_max_turns' && hop >= maxHops) {
    return {
      sdkSessionId: result.sdkSessionId,
      resultText: `This step needed more tool calls than ${maxHops} continuation rounds could cover — consider splitting the plan/checklist step further.`,
      isError: true,
      usage,
      contextTokens: result.contextTokens,
    };
  }

  return {
    sdkSessionId: result.sdkSessionId,
    resultText: result.resultText,
    isError: result.isError,
    usage,
    contextTokens: result.contextTokens,
  };
}

/**
 * A single prompt/response, no tools, no conversation continuity — for the
 * coordinator agent's decision calls (coordinator-agent.ts) on the "claude"
 * provider. Deliberately not runClaudeAgentTurn: the coordinator never
 * needs an MCP server, streamed events, or a resumable session, just one
 * plain text response per decision.
 */
export async function runClaudeSingleShot(params: { systemPrompt: string; prompt: string; model?: string }): Promise<string> {
  const { systemPrompt, prompt, model } = params;
  let resultText = '';
  let sawError = false;
  let errorText = '';

  for await (const message of query({
    prompt,
    options: {
      systemPrompt: { type: 'custom', prompt: systemPrompt },
      tools: [],
      maxTurns: 1,
      ...CLAUDE_ISOLATION,
      ...(model ? { model } : {}),
    },
  })) {
    if (message.type !== 'result') continue;
    if (message.subtype !== 'success') {
      sawError = true;
      errorText = message.errors.join('\n');
    } else if (message.is_error) {
      sawError = true;
      errorText = message.result;
    } else {
      resultText = message.result;
    }
  }

  if (sawError) throw new Error(errorText || 'runClaudeSingleShot failed with no error detail.');
  return resultText;
}

/**
 * Verifies `claude login` (or an equivalent ambient credential) actually
 * works, without spending a real turn on anything — used by the Settings
 * page's Test button for the "claude" provider, which has no API key field
 * to validate instead.
 */
export async function testClaudeLogin(): Promise<void> {
  let sawError = false;
  let errorText = '';

  for await (const message of query({
    prompt: 'Reply with just "ok".',
    options: { tools: [], maxTurns: 1, ...CLAUDE_ISOLATION },
  })) {
    if (message.type !== 'result') continue;
    if (message.subtype !== 'success') {
      sawError = true;
      errorText = message.errors.join('\n');
    } else if (message.is_error) {
      sawError = true;
      errorText = message.result;
    }
  }

  if (sawError) {
    throw new Error(errorText || 'Not logged in — run `claude login` in a terminal on this machine, then try again.');
  }
}
