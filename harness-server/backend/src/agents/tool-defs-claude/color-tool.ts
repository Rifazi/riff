import { tool } from '@anthropic-ai/claude-agent-sdk';
import { analyzeColorsDescription, analyzeColorsSchema, createAnalyzeColorsExecute } from '../tool-defs/color-tool.js';
import { wrapForClaudeSdk } from './wrap.js';

export function createAnalyzeColorsToolClaude(deps: { repoRoot: string }) {
  return tool('analyze_colors', analyzeColorsDescription, analyzeColorsSchema.shape, wrapForClaudeSdk(createAnalyzeColorsExecute(deps)), {
    annotations: { readOnlyHint: true },
  });
}
