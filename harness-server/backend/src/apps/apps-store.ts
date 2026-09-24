import { promises as fs } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { listSessions } from '../sessions/session-store.js';
import { validateRepoRoot, ensureDocsDir, slugifyAppId, LEGACY_APP_ID, type AppConfig, type CheckCommands } from './apps.js';

// Deliberately separate from backend/.env, same treatment as
// local-settings.json — this is runtime-editable via the Apps page, no
// restart needed, never committed (it holds machine-local absolute paths).
const APPS_PATH = path.join(config.harnessRoot, 'backend', 'local-apps.json');

export { LEGACY_APP_ID };

let cache: AppConfig[] | null = null;

async function seedFromLegacyEnv(): Promise<AppConfig[]> {
  const legacyRoot = process.env.TARGET_REPO_ROOT?.trim();
  if (!legacyRoot) return [];
  try {
    const resolved = validateRepoRoot(legacyRoot);
    ensureDocsDir(resolved);
    return [{ id: LEGACY_APP_ID, name: 'Customer-EDI', repoRoot: resolved }];
  } catch {
    return [];
  }
}

async function readApps(): Promise<AppConfig[]> {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(APPS_PATH, 'utf8');
    cache = JSON.parse(raw) as AppConfig[];
  } catch {
    cache = await seedFromLegacyEnv();
    if (cache.length > 0) await writeApps(cache);
  }
  return cache;
}

async function writeApps(apps: AppConfig[]): Promise<void> {
  cache = apps;
  await fs.mkdir(path.dirname(APPS_PATH), { recursive: true });
  await fs.writeFile(APPS_PATH, JSON.stringify(apps, null, 2), 'utf8');
}

export async function listApps(): Promise<AppConfig[]> {
  return readApps();
}

export async function getApp(id: string): Promise<AppConfig> {
  const apps = await readApps();
  const app = apps.find((a) => a.id === id);
  if (!app) throw new Error(`App "${id}" not found.`);
  return app;
}

export interface AppWriteResult {
  app: AppConfig;
  docsInitialized: boolean;
}

export async function createApp(input: { name: string; repoRoot: string; checkCommands?: CheckCommands }): Promise<AppWriteResult> {
  const resolved = validateRepoRoot(input.repoRoot);
  const docsInitialized = ensureDocsDir(resolved);
  const apps = await readApps();

  let id = slugifyAppId(input.name);
  if (apps.some((a) => a.id === id)) {
    let suffix = 2;
    while (apps.some((a) => a.id === `${id}-${suffix}`)) suffix++;
    id = `${id}-${suffix}`;
  }

  const app: AppConfig = {
    id,
    name: input.name.trim(),
    repoRoot: resolved,
    ...(input.checkCommands ? { checkCommands: input.checkCommands } : {}),
  };
  await writeApps([...apps, app]);
  return { app, docsInitialized };
}

export async function updateApp(
  id: string,
  patch: { name?: string; repoRoot?: string; checkCommands?: CheckCommands }
): Promise<AppWriteResult> {
  const apps = await readApps();
  const index = apps.findIndex((a) => a.id === id);
  if (index === -1) throw new Error(`App "${id}" not found.`);

  const resolvedRepoRoot = patch.repoRoot?.trim() ? validateRepoRoot(patch.repoRoot) : null;
  const docsInitialized = resolvedRepoRoot ? ensureDocsDir(resolvedRepoRoot) : false;

  const updated: AppConfig = {
    ...apps[index],
    ...(patch.name?.trim() ? { name: patch.name.trim() } : {}),
    ...(resolvedRepoRoot ? { repoRoot: resolvedRepoRoot } : {}),
    ...(patch.checkCommands !== undefined ? { checkCommands: patch.checkCommands } : {}),
  };
  const next = [...apps];
  next[index] = updated;
  await writeApps(next);
  return { app: updated, docsInitialized };
}

export class AppInUseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppInUseError';
  }
}

export async function deleteApp(id: string): Promise<void> {
  const sessions = await listSessions();
  if (sessions.some((s) => s.appId === id)) {
    throw new AppInUseError(`App "${id}" still has sessions — delete or reassign them first.`);
  }
  const apps = await readApps();
  await writeApps(apps.filter((a) => a.id !== id));
}
