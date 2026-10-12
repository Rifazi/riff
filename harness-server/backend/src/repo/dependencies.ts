import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { compactOutput } from '../agents/tool-defs/output-compress.js';

const execFileAsync = promisify(execFile);

// Folders that never hold a package of the repo's own.
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next', '.turbo', 'cdk.out', 'vendor', 'harness']);
// Root plus two levels (server/, packages/api/) covers the layouts agents scaffold.
const MAX_DEPTH = 2;
const INSTALL_TIMEOUT_MS = 300_000;

// One install per folder at a time: parallel QA reviewers and engineers can
// call run_checked_command on the same checkout together.
const inFlight = new Map<string, Promise<string | null>>();

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function mtime(file: string): Promise<number | null> {
  try {
    return (await fs.stat(file)).mtimeMs;
  } catch {
    return null;
  }
}

/** Folders under `repoRoot` (root included) with their own package.json, workspaces left to the root's install. */
export async function findPackageDirs(repoRoot: string): Promise<string[]> {
  const root = await readJson(path.join(repoRoot, 'package.json'));
  // npm workspaces: the root install covers every workspace.
  if (root?.workspaces) return ['.'];
  const found: string[] = root ? ['.'] : [];
  const walk = async (rel: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(path.join(repoRoot, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      const child = rel === '.' ? entry.name : `${rel}/${entry.name}`;
      if (await mtime(path.join(repoRoot, child, 'package.json'))) found.push(child);
      await walk(child, depth + 1);
    }
  };
  await walk('.', 1);
  return found;
}

/**
 * Whether `dir`'s declared dependencies need installing: no node_modules, or
 * package.json changed since npm last installed (npm rewrites
 * node_modules/.package-lock.json on every install). A symlinked
 * node_modules (a team worktree sharing the main checkout's) is left alone.
 */
async function needsInstall(dir: string): Promise<boolean> {
  const modules = path.join(dir, 'node_modules');
  try {
    if ((await fs.lstat(modules)).isSymbolicLink()) return false;
  } catch {
    return true;
  }
  const manifest = await mtime(path.join(dir, 'package.json'));
  const installed = await mtime(path.join(modules, '.package-lock.json'));
  return installed === null || (manifest !== null && manifest > installed);
}

async function install(repoRoot: string, rel: string): Promise<string | null> {
  const dir = path.join(repoRoot, rel);
  if (!(await needsInstall(dir))) return null;
  const label = rel === '.' ? 'the repo root' : `${rel}/`;
  try {
    await execFileAsync('npm', ['install', '--no-audit', '--no-fund'], { cwd: dir, timeout: INSTALL_TIMEOUT_MS, maxBuffer: 10_000_000 });
    return `Installed dependencies in ${label}.`;
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; killed?: boolean; message?: string };
    return `npm install in ${label} failed${e.killed ? ' (TIMED OUT)' : ''}:\n${compactOutput(e.stdout ?? '', e.stderr ?? e.message ?? '')}`;
  }
}

/**
 * Installs the declared dependencies of every package in the checkout that
 * hasn't been installed (or whose package.json changed since), so the repo's
 * checks can run in a fresh worktree or a just-scaffolded package. Returns
 * one line per install it ran, empty when there was nothing to do.
 */
export async function ensureDependencies(repoRoot: string): Promise<string[]> {
  const notes: string[] = [];
  for (const rel of await findPackageDirs(repoRoot)) {
    const key = path.join(repoRoot, rel);
    let run = inFlight.get(key);
    if (!run) {
      run = install(repoRoot, rel).finally(() => inFlight.delete(key));
      inFlight.set(key, run);
    }
    const note = await run;
    if (note) notes.push(note);
  }
  return notes;
}
