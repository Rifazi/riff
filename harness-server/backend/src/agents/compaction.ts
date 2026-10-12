// When a conversation is cut and compacted (sdk-client.ts): pure, so it's
// tested without loading either agent engine
// (frontend/tests/harness-server/context-cut.test.ts).

// Compaction only pays off when the conversation has grown well past where
// it started: a context that begins near atTokens (long approved docs)
// would otherwise be compacted, at the cost of a handoff, after every hop.
export const MIN_GROWTH_TO_COMPACT = 20_000;

export function shouldCompact(compaction: { atTokens: number } | undefined, contextTokens: number, startTokens: number): boolean {
  return Boolean(compaction) && contextTokens >= compaction!.atTokens && contextTokens - startTokens >= MIN_GROWTH_TO_COMPACT;
}
