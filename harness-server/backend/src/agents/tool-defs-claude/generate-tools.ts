import { tool } from '@anthropic-ai/claude-agent-sdk';
import { emptySchema, runGeneratePathsDescription, runGenerateOpenApiDescription, createGenerateExecutors } from '../tool-defs/generate-tools.js';
import { wrapForClaudeSdk } from './wrap.js';

export function createGenerateToolsClaude(deps: { repoRoot: string }) {
  const { runGeneratePathsExecute, runGenerateOpenApiExecute } = createGenerateExecutors(deps);
  return {
    runGeneratePathsToolClaude: tool(
      'run_generate_paths',
      runGeneratePathsDescription,
      emptySchema.shape,
      wrapForClaudeSdk(runGeneratePathsExecute)
    ),
    runGenerateOpenApiToolClaude: tool(
      'run_generate_openapi',
      runGenerateOpenApiDescription,
      emptySchema.shape,
      wrapForClaudeSdk(runGenerateOpenApiExecute)
    ),
  };
}
