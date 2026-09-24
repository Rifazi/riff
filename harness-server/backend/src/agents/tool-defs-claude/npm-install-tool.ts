import { tool } from '@anthropic-ai/claude-agent-sdk';
import { runNpmInstallSchema, runNpmInstallDescription, createRunNpmInstallExecute } from '../tool-defs/npm-install-tool.js';
import { wrapForClaudeSdk } from './wrap.js';

export function createRunNpmInstallToolClaude(deps: { repoRoot: string }) {
  return tool(
    'run_npm_install',
    runNpmInstallDescription,
    runNpmInstallSchema.shape,
    wrapForClaudeSdk(createRunNpmInstallExecute(deps))
  );
}
