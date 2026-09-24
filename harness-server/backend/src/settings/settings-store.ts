import { promises as fs } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import {
  DEFAULT_SETTINGS,
  PROVIDERS,
  type HarnessSettings,
  type JiraSettings,
  type Provider,
  type Role,
  type RoleModelConfig,
} from './settings.js';

// Deliberately separate from backend/.env: this is app-level config the
// Settings UI reads/writes at runtime (no restart needed), never committed.
const SETTINGS_PATH = path.join(config.harnessRoot, 'backend', 'local-settings.json');

export async function getSettings(): Promise<HarnessSettings> {
  try {
    const raw = await fs.readFile(SETTINGS_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<HarnessSettings>;
    return {
      credentials: { ...parsed.credentials },
      models: { ...DEFAULT_SETTINGS.models, ...parsed.models },
      jira: { ...DEFAULT_SETTINGS.jira, ...parsed.jira },
    };
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

export interface SettingsPatch {
  credentials?: Partial<Record<Provider, string | null>>;
  models?: Partial<Record<Role, RoleModelConfig>>;
  // apiToken: null clears it, a non-empty string replaces it, undefined/''
  // leaves the stored value untouched — same convention as `credentials`.
  jira?: Partial<Omit<JiraSettings, 'apiToken'>> & { apiToken?: string | null };
}

export async function updateSettings(patch: SettingsPatch): Promise<HarnessSettings> {
  const current = await getSettings();

  if (patch.credentials) {
    for (const provider of PROVIDERS) {
      const value = patch.credentials[provider];
      if (value === null) {
        delete current.credentials[provider];
      } else if (typeof value === 'string' && value.trim()) {
        current.credentials[provider] = value.trim();
      }
      // undefined or empty string: leave the stored value untouched
    }
  }

  if (patch.models) {
    current.models = { ...current.models, ...patch.models };
  }

  if (patch.jira) {
    const { apiToken, ...rest } = patch.jira;
    current.jira = { ...current.jira, ...rest };
    if (apiToken === null) {
      current.jira.apiToken = '';
    } else if (typeof apiToken === 'string' && apiToken.trim()) {
      current.jira.apiToken = apiToken.trim();
    }
  }

  await fs.mkdir(path.dirname(SETTINGS_PATH), { recursive: true });
  await fs.writeFile(SETTINGS_PATH, JSON.stringify(current, null, 2), 'utf8');
  return current;
}

export async function getCredential(provider: Provider): Promise<string | null> {
  const settings = await getSettings();
  return settings.credentials[provider]?.trim() || null;
}

export async function getRoleModelConfig(role: Role): Promise<RoleModelConfig> {
  const settings = await getSettings();
  return settings.models[role];
}

export async function getJiraSettings(): Promise<JiraSettings> {
  const settings = await getSettings();
  return settings.jira;
}
