import { promises as fs } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import {
  DEFAULT_SETTINGS,
  PROVIDERS,
  normalizeOllamaEndpoint,
  providerNeedsApiKey,
  type ClassificationSettings,
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
      // Older files predate the ollama provider — fall back to the default
      // endpoint rather than leaving it undefined.
      ollamaEndpoint:
        typeof parsed.ollamaEndpoint === 'string' && parsed.ollamaEndpoint.trim()
          ? normalizeOllamaEndpoint(parsed.ollamaEndpoint)
          : DEFAULT_SETTINGS.ollamaEndpoint,
      jira: { ...DEFAULT_SETTINGS.jira, ...parsed.jira },
      classification: { ...DEFAULT_SETTINGS.classification, ...parsed.classification },
    };
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

export interface SettingsPatch {
  credentials?: Partial<Record<Provider, string | null>>;
  models?: Partial<Record<Role, RoleModelConfig>>;
  // Ollama's server URL (e.g. http://localhost:11434). A non-empty string
  // replaces the stored value; undefined/'' leaves it untouched.
  ollamaEndpoint?: string;
  // apiToken: null clears it, a non-empty string replaces it, undefined/''
  // leaves the stored value untouched — same convention as `credentials`.
  jira?: Partial<Omit<JiraSettings, 'apiToken'>> & { apiToken?: string | null };
  // Takes effect on the next classify_text call — agents/helpers/classifier/classifier.ts
  // re-reads this and hot-swaps its in-memory pipeline, no restart needed.
  classification?: Partial<ClassificationSettings>;
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

  if (typeof patch.ollamaEndpoint === 'string' && patch.ollamaEndpoint.trim()) {
    current.ollamaEndpoint = normalizeOllamaEndpoint(patch.ollamaEndpoint);
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

  if (patch.classification) {
    current.classification = { ...current.classification, ...patch.classification };
  }

  await fs.mkdir(path.dirname(SETTINGS_PATH), { recursive: true });
  await fs.writeFile(SETTINGS_PATH, JSON.stringify(current, null, 2), 'utf8');
  return current;
}

/**
 * The key to send for `provider`: the stored one, or '' for the providers
 * that need none (claude authenticates via `claude login`, ollama via a
 * local unauthenticated server). null means this provider needs a key and
 * none is saved — the caller should stop and ask the human for one.
 */
export async function getApiKey(provider: Provider): Promise<string | null> {
  const settings = await getSettings();
  const key = settings.credentials[provider]?.trim();
  if (key) return key;
  return providerNeedsApiKey(provider) ? null : '';
}

export async function getRoleModelConfig(role: Role): Promise<RoleModelConfig> {
  const settings = await getSettings();
  return settings.models[role];
}

export async function getJiraSettings(): Promise<JiraSettings> {
  const settings = await getSettings();
  return settings.jira;
}
