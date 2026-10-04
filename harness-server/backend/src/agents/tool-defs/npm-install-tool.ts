import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tool } from 'ai';
import { z } from 'zod';
import { compactOutput } from './output-compress.js';

const execFileAsync = promisify(execFile);

// Matches a bare or scoped package name with an optional version/tag
// specifier (lodash, lodash@4.17.21, @scope/name@^2.0.0) and nothing else —
// in particular never a leading "-", which is how a "package name" could
// otherwise smuggle an arbitrary npm flag into the argv array.
const PACKAGE_SPEC_RE = /^(@[a-z0-9][a-z0-9-._]*\/)?[a-z0-9][a-z0-9-._]*(@[\w.^~<>=|-]+)?$/i;

// Same "no leading -" rationale as PACKAGE_SPEC_RE — an npm workspace name
// is either a plain directory-ish name (frontend) or a scoped package name
// declared in that workspace's own package.json (@scope/frontend); never a
// flag.
const WORKSPACE_RE = /^(@[a-z0-9][a-z0-9-._]*\/)?[a-z0-9][a-z0-9-._]*$/i;

export const runNpmInstallSchema = z.object({
  packages: z
    .array(z.string())
    .min(1)
    .describe('One or more npm package specs to install, e.g. ["lodash", "@types/lodash@^4.14.0"].'),
  dev: z.boolean().optional().describe('True to install as a devDependency (--save-dev). Default false.'),
  workspace: z
    .string()
    .optional()
    .describe('npm-workspaces repo only: the workspace (directory or package name) the dependency belongs to. Omit for the root.'),
});
export const runNpmInstallDescription =
  '`npm install` packages — the only way to change package.json. Only for a package nothing already in the ' +
  'repo covers (check with search_code first). Commit package.json and package-lock.json (and the ' +
  "workspace's package.json) in your next git_commit.";

/**
 * The only tool allowed to modify package.json — it goes through npm itself
 * rather than write_file/edit_file so the lockfile and node_modules stay
 * consistent with it, the same reason a human wouldn't hand-edit
 * package.json's dependency block either. Package specs are validated
 * against PACKAGE_SPEC_RE before being passed to execFile's argv array, so
 * a "package name" can never be interpreted as an npm flag.
 */
export function createRunNpmInstallExecute(deps: { repoRoot: string }) {
  return async ({ packages, dev, workspace }: z.infer<typeof runNpmInstallSchema>): Promise<string> => {
    for (const pkg of packages) {
      if (!PACKAGE_SPEC_RE.test(pkg)) {
        throw new Error(`"${pkg}" doesn't look like a valid npm package spec (name or name@version). Not installed.`);
      }
    }
    if (workspace !== undefined && !WORKSPACE_RE.test(workspace)) {
      throw new Error(`"${workspace}" doesn't look like a valid npm workspace name. Not installed.`);
    }

    const args = [
      'install',
      '--save',
      ...(dev ? ['--save-dev'] : []),
      ...(workspace ? ['--workspace', workspace] : []),
      ...packages,
    ];
    try {
      await execFileAsync('npm', args, {
        cwd: deps.repoRoot,
        timeout: 180_000,
        maxBuffer: 10_000_000,
      });
      const target = workspace ? ` into workspace "${workspace}"` : '';
      return `Installed ${packages.join(', ')}${dev ? ' (devDependency)' : ''}${target}.`;
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; killed?: boolean; message?: string };
      const timedOut = e.killed ? ' (TIMED OUT)' : '';
      return (
        `npm install failed${timedOut} for ${packages.join(', ')}.\n\n` +
        compactOutput(e.stdout ?? '', e.stderr ?? e.message ?? '')
      );
    }
  };
}

export function createRunNpmInstallTool(deps: { repoRoot: string }) {
  return tool({
    description: runNpmInstallDescription,
    inputSchema: runNpmInstallSchema,
    execute: createRunNpmInstallExecute(deps),
  });
}
