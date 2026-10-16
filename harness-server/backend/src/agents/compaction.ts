// When a conversation is cut and compacted (sdk-client.ts): pure, so it's
// tested without loading either agent engine
// (frontend/tests/harness-server/context-cut.test.ts).

// Compaction only pays off when the conversation has grown well past where
// it started: a context that begins near atTokens (long approved docs)
// would otherwise be compacted, at the cost of a handoff, after every hop.
export const MIN_GROWTH_TO_COMPACT = 20_000;

// A deferred cut (see compactionDeferral) still happens here: past this a
// conversation costs more per request than re-orienting would.
export const DEFER_CEILING_TOKENS = 90_000;

export function shouldCompact(
  compaction: { atTokens: number; defer?: () => boolean } | undefined,
  contextTokens: number,
  startTokens: number,
): boolean {
  if (!compaction || contextTokens < compaction.atTokens || contextTokens - startTokens < MIN_GROWTH_TO_COMPACT) return false;
  return contextTokens >= DEFER_CEILING_TOKENS || !compaction.defer?.();
}

// Tool calls that move the work forward. A conversation cut before making
// one re-reads what it had just read and is cut again: in 151 mid-step cuts,
// 35 conversations wrote nothing, up to 4 in a row.
const PROGRESS_TOOLS = new Set([
  'write_file',
  'edit_file',
  'delete_file',
  'finish_step',
  'git_commit',
  'assign_team',
  'build_solo',
  'report_workstream',
  'merge_workstream',
  'send_back_workstream',
  'drop_workstreams',
]);
// The lead's verdict on a workstream he's reviewing.
const VERDICT_TOOLS = new Set(['merge_workstream', 'send_back_workstream', 'drop_workstreams']);

const bareToolName = (name: string | undefined) => (name ?? '').replace(/^mcp__[^_]+(-[^_]+)?__/, '');

// A tool result's text: a string (AI SDK) or MCP content parts (Claude).
const resultText = (result: unknown): string =>
  typeof result === 'string'
    ? result
    : Array.isArray(result)
      ? result.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('\n')
      : JSON.stringify(result ?? '');

/**
 * Why this conversation shouldn't be cut yet, or null: it hasn't made
 * progress since it started, or the lead is between review_workstream and
 * his verdict (cut there, he reviewed the same branch five times over in one
 * turn). `entries` is the conversation so far, oldest first.
 */
export function compactionDeferral(
  entries: { role: string; toolName?: string; toolCallId?: string; toolResult?: unknown; isError?: boolean }[],
): string | null {
  const calls = entries.filter((e) => e.role === 'tool_call').map((e) => bareToolName(e.toolName));
  // A progress call that changed nothing isn't progress: a finish_step
  // refused by failing checks with nothing new to commit was cut straight
  // away, and the next conversation re-read everything and called it again.
  const results = new Map(entries.filter((e) => e.role === 'tool_result' && e.toolCallId).map((e) => [e.toolCallId, e]));
  const moved = entries.some((e) => {
    if (e.role !== 'tool_call' || !PROGRESS_TOOLS.has(bareToolName(e.toolName))) return false;
    const result = e.toolCallId ? results.get(e.toolCallId) : undefined;
    return !result || (!result.isError && !/^\s*Nothing\b/.test(resultText(result.toolResult)));
  });
  if (!moved) return 'no progress yet';
  const lastReview = calls.lastIndexOf('review_workstream');
  if (lastReview >= 0 && !calls.slice(lastReview + 1).some((n) => VERDICT_TOOLS.has(n))) return 'mid-review';
  return null;
}
