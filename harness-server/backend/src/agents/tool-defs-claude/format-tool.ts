import { tool } from '@anthropic-ai/claude-agent-sdk';
import { runPrettierSchema, runPrettierDescription, createRunPrettierExecute } from '../tool-defs/format-tool.js';
import { wrapForClaudeSdk } from './wrap.js';

export function createRunPrettierToolClaude(deps: { repoRoot: string }) {
  return tool(
    'run_prettier',
    runPrettierDescription,
    runPrettierSchema.shape,
    wrapForClaudeSdk(createRunPrettierExecute(deps))
  );
}
