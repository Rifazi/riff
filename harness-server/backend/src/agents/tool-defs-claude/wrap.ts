/**
 * Every tool's real logic lives once, in tool-defs/*.ts, as a plain
 * execute function that returns a value or throws. The AI-SDK-format tool
 * (used for the anthropic/openai/google providers) consumes that function
 * directly. This wraps the same function for the Claude Agent SDK's
 * `tool()` format (used for the "claude" subscription-login provider),
 * converting the return-or-throw convention into its {content, isError}
 * shape — so the failure-mode decision (throw vs. return, see CLAUDE.md)
 * only has to be made once per tool, not once per engine.
 */
export function wrapForClaudeSdk<Args>(fn: (args: Args) => Promise<unknown>) {
  return async (args: Args) => {
    try {
      const result = await fn(args);
      const text = typeof result === 'string' ? result : JSON.stringify(result);
      return { content: [{ type: 'text' as const, text }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text' as const, text: message }], isError: true };
    }
  };
}
