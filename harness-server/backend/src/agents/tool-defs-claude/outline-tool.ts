import { tool } from '@anthropic-ai/claude-agent-sdk';
import { outlineFileSchema, outlineFileDescription, createOutlineFileExecute } from '../tool-defs/outline-tool.js';
import { wrapForClaudeSdk } from './wrap.js';

export function createOutlineFileToolClaude(deps: { repoRoot: string }) {
  return tool(
    'outline_file',
    outlineFileDescription,
    outlineFileSchema.shape,
    wrapForClaudeSdk(createOutlineFileExecute(deps)),
    { annotations: { readOnlyHint: true } }
  );
}
