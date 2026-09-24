import { promises as fs } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { listApps } from '../apps/apps-store.js';
import { LEGACY_APP_ID } from '../apps/apps.js';
import type { Role } from './settings.js';

// Runtime-editable per-app, per-role system prompt overrides, set from the
// Apps page — same treatment as local-settings.json/local-apps.json.
// When unset for a role, that role falls back to the checked-in base prompt
// (backend/src/agents/prompts/<role>-agent.md, or the inline
// DECISION_INSTRUCTIONS constant for "coordinator", which has no file).
const PROMPTS_PATH = path.join(config.harnessRoot, 'backend', 'local-prompts.json');

const LEGACY_PROMPTS_DIR = path.join(config.harnessRoot, 'backend/src/agents/prompts/customer-edi-legacy');
const LEGACY_SEEDED_ROLES: Role[] = ['requirements', 'plan', 'coding', 'qa'];

type PromptStore = Partial<Record<string, Partial<Record<Role, string>>>>;

let cache: PromptStore | null = null;

// The four base prompts used to hardcode Customer-EDI's own conventions
// (hexagonal Lambda/CDK, Tungsten/Square D/Siemens, transmission-log
// buckets, ...). Now that the base prompts are generic, that content is
// preserved verbatim as the legacy app's own prompt overrides, so upgrading
// this harness doesn't change what the existing Customer-EDI sessions do.
async function seedLegacyOverrides(): Promise<PromptStore> {
  const apps = await listApps();
  if (!apps.some((a) => a.id === LEGACY_APP_ID)) return {};

  const overrides: Partial<Record<Role, string>> = {};
  for (const role of LEGACY_SEEDED_ROLES) {
    try {
      overrides[role] = await fs.readFile(path.join(LEGACY_PROMPTS_DIR, `${role}-agent.md`), 'utf8');
    } catch {
      // legacy file missing — leave that role on the (now generic) base
    }
  }
  return { [LEGACY_APP_ID]: overrides };
}

async function readStore(): Promise<PromptStore> {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(PROMPTS_PATH, 'utf8');
    cache = JSON.parse(raw) as PromptStore;
  } catch {
    cache = await seedLegacyOverrides();
    if (Object.keys(cache).length > 0) await writeStore(cache);
  }
  return cache;
}

async function writeStore(store: PromptStore): Promise<void> {
  cache = store;
  await fs.mkdir(path.dirname(PROMPTS_PATH), { recursive: true });
  await fs.writeFile(PROMPTS_PATH, JSON.stringify(store, null, 2), 'utf8');
}

export async function getPromptOverride(appId: string, role: Role): Promise<string | null> {
  const store = await readStore();
  return store[appId]?.[role] ?? null;
}

export async function getPromptOverridesForApp(appId: string): Promise<Partial<Record<Role, string>>> {
  const store = await readStore();
  return store[appId] ?? {};
}

export async function setPromptOverride(appId: string, role: Role, text: string | null): Promise<void> {
  const store = await readStore();
  const forApp = { ...store[appId] };
  if (text === null || !text.trim()) {
    delete forApp[role];
  } else {
    forApp[role] = text;
  }
  await writeStore({ ...store, [appId]: forApp });
}
