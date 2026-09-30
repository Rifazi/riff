import { tool } from '@anthropic-ai/claude-agent-sdk';
import { proposeThemeSchema, proposeThemeDescription, createProposeThemeExecute } from '../tool-defs/propose-theme-tool.js';
import { wrapForClaudeSdk } from './wrap.js';

export function createProposeThemeToolClaude(deps: { sessionId: string; repoRoot: string }) {
  return tool('propose_theme', proposeThemeDescription, proposeThemeSchema.shape, wrapForClaudeSdk(createProposeThemeExecute(deps)));
}
