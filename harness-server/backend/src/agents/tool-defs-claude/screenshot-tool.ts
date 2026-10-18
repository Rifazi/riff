import { tool } from '@anthropic-ai/claude-agent-sdk';
import { createScreenshotExecute, screenshotDescription, screenshotSchema } from '../tool-defs/screenshot-tool.js';

/**
 * Claude engine: the image goes back as an MCP image block, which the model
 * sees. The AI-SDK engine's twin is createScreenshotTool, which strips the
 * pixels from the stored history afterwards.
 */
export function createScreenshotToolClaude(deps: { sessionId: string; repoRoot: string }) {
  const execute = createScreenshotExecute(deps);
  return tool(
    'screenshot_app',
    screenshotDescription,
    screenshotSchema.shape,
    async (args) => {
      try {
        const result = await execute(args);
        return {
          content: [
            { type: 'text' as const, text: result.text },
            { type: 'image' as const, data: result.image.data, mimeType: result.image.mediaType },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }], isError: true };
      }
    },
    { annotations: { readOnlyHint: true } },
  );
}
