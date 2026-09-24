import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tool } from 'ai';
import { z } from 'zod';

const execFileAsync = promisify(execFile);

async function runNpmScript(repoRoot: string, script: string, timeoutMs: number): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync('npm', ['run', script], {
      cwd: repoRoot,
      timeout: timeoutMs,
      maxBuffer: 5_000_000,
    });
    return `${stdout}\n${stderr}`.trim() || `${script} completed.`;
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return `${script} failed:\n${e.stdout ?? ''}\n${e.stderr ?? e.message ?? err}`;
  }
}

export const emptySchema = z.object({});

export const runGeneratePathsDescription =
  'Regenerate the TypeScript path aliases (@adapters, @models, etc.) via `npm run generate:paths`. Run this ' +
  'after adding files that new imports depend on, if aliases aren\'t resolving.';

export const runGenerateOpenApiDescription =
  'Regenerate openapi/api.json from the CDK stateless stack via `npm run generate:openapi`. Run this after ' +
  'adding a new API route.';

// These are the coding agent's only two shell-invoking tools — direct
// wrappers around the exact recipe steps in docs/development.md, not a
// general exec capability.
export function createGenerateExecutors(deps: { repoRoot: string }) {
  const runGeneratePathsExecute = async (): Promise<string> => runNpmScript(deps.repoRoot, 'generate:paths', 60_000);
  const runGenerateOpenApiExecute = async (): Promise<string> => runNpmScript(deps.repoRoot, 'generate:openapi', 120_000);
  return { runGeneratePathsExecute, runGenerateOpenApiExecute };
}

export function createGenerateTools(deps: { repoRoot: string }) {
  const { runGeneratePathsExecute, runGenerateOpenApiExecute } = createGenerateExecutors(deps);
  return {
    runGeneratePathsTool: tool({
      description: runGeneratePathsDescription,
      inputSchema: emptySchema,
      execute: runGeneratePathsExecute,
    }),
    runGenerateOpenApiTool: tool({
      description: runGenerateOpenApiDescription,
      inputSchema: emptySchema,
      execute: runGenerateOpenApiExecute,
    }),
  };
}
