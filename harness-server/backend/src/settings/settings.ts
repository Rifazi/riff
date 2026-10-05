import { localModelStatus, type LocalModelStatus } from '../agents/local-llm.js';

export type Provider = 'claude' | 'anthropic' | 'openai' | 'google' | 'ollama';

// The providers that run through the AI-SDK engine — as opposed to "claude",
// which authenticates via `claude login` and runs through the Claude Agent
// SDK engine instead. "ollama" is in here engine-wise but takes no API key:
// it talks to the Ollama server on this machine (see settings/ollama.ts).
export type ApiKeyProvider = Exclude<Provider, 'claude'>;

export const PROVIDERS: Provider[] = ['claude', 'anthropic', 'openai', 'google', 'ollama'];

export function isProvider(value: string): value is Provider {
  return (PROVIDERS as string[]).includes(value);
}

// "claude" authenticates via `claude login` (a Pro/Max subscription, OAuth,
// billed against that plan) rather than a pasted API key; "ollama" is a
// local, unauthenticated server. Everything else needs a stored key.
export function providerNeedsApiKey(provider: Provider): boolean {
  return provider !== 'claude' && provider !== 'ollama';
}

export interface RoleModelConfig {
  provider: Provider;
  model: string;
  // Coding only: the cheaper model plan steps tagged "light" run on (see
  // agents/model-routing.ts). Unset = the provider's default light model;
  // '' = off, every step runs on `model`.
  lightModel?: string;
  // Coordinator only: try Riff's built-in local model (agents/local-llm.ts)
  // before `model`. Unset = on.
  useLocalModel?: boolean;
  // Coding only: when non-empty, Jack's automatic solo step turns AND every
  // workstream team member run on this Ollama model instead of `provider`/
  // `model`, saving cloud tokens on work Jack judges simple enough to spin
  // up locally. '' = off.
  localTeamModel?: string;
}

export type Role = 'requirements' | 'plan' | 'coding' | 'qa' | 'coordinator';
export const ROLES: Role[] = ['requirements', 'plan', 'coding', 'qa', 'coordinator'];

export function isRole(value: string): value is Role {
  return (ROLES as string[]).includes(value);
}

// Jira Cloud only (email + API token via Basic auth against
// https://<site>.atlassian.net/rest/api/3) — see repo/jira-client.ts.
// `epicLinkFieldId` is only needed on classic (company-managed) projects,
// where the epic-child link is a custom field rather than the standard
// `parent` field team-managed projects use — left blank, jira-client.ts
// tries `parent` first and only falls back to this if it's set.
export interface JiraSettings {
  baseUrl: string;
  email: string;
  apiToken: string;
  issueType: string;
  epicLinkFieldId: string;
}

export const DEFAULT_JIRA_SETTINGS: JiraSettings = {
  baseUrl: '',
  email: '',
  apiToken: '',
  issueType: 'Task',
  epicLinkFieldId: '',
};

// Where the system Ollama server lives by default (its OpenAI-compatible
// API is <endpoint>/v1) — user-editable in Settings → Dev Agents.
export const DEFAULT_OLLAMA_ENDPOINT = 'http://localhost:11434';

/** Endpoint as stored: trimmed, no trailing slash. */
export function normalizeOllamaEndpoint(endpoint: string): string {
  return endpoint.trim().replace(/\/+$/, '');
}

// The on-device classification tool (agents/classification.ts) runs
// transformers.js's zero-shot-classification pipeline, which needs an ONNX
// sequence-classification model trained for NLI/MNLI. These three Xenova
// conversions are the curated choices offered in Settings → Dev Agents; the
// trade-off between them is download size and inference speed versus accuracy
// on subtle label distinctions. Sizes are the quantized ONNX weights actually
// downloaded, so they're approximate.
export interface ClassificationModelOption {
  id: string;
  label: string;
  description: string;
}

export const CLASSIFICATION_MODELS: ClassificationModelOption[] = [
  {
    id: 'Xenova/distilbert-base-uncased-mnli',
    label: 'DistilBERT MNLI',
    description: 'Smallest and fastest (~70 MB). Good for clear-cut label sets. Recommended default.',
  },
  {
    id: 'Xenova/nli-deberta-v3-xsmall',
    label: 'DeBERTa v3 XSmall NLI',
    description: 'Balanced (~90 MB). Noticeably better on nuanced or overlapping labels, still fast.',
  },
  {
    id: 'Xenova/bart-large-mnli',
    label: 'BART Large MNLI',
    description: 'Most accurate (~400 MB). Slowest to download and to run — for subtle distinctions.',
  },
];

export const DEFAULT_CLASSIFICATION_MODEL = CLASSIFICATION_MODELS[0].id;

export function isClassificationModel(value: string): boolean {
  return CLASSIFICATION_MODELS.some((option) => option.id === value);
}

export interface ClassificationSettings {
  model: string;
}

export const DEFAULT_CLASSIFICATION_SETTINGS: ClassificationSettings = {
  model: DEFAULT_CLASSIFICATION_MODEL,
};

export interface HarnessSettings {
  credentials: Partial<Record<Provider, string>>;
  models: Record<Role, RoleModelConfig>;
  ollamaEndpoint: string;
  jira: JiraSettings;
  classification: ClassificationSettings;
}

export const DEFAULT_SETTINGS: HarnessSettings = {
  credentials: {},
  models: {
    requirements: { provider: 'claude', model: 'claude-sonnet-5' },
    plan: { provider: 'claude', model: 'claude-sonnet-5' },
    coding: { provider: 'claude', model: 'claude-sonnet-5' },
    qa: { provider: 'claude', model: 'claude-sonnet-5' },
    coordinator: { provider: 'claude', model: 'claude-haiku-4-5' },
  },
  ollamaEndpoint: DEFAULT_OLLAMA_ENDPOINT,
  jira: DEFAULT_JIRA_SETTINGS,
  classification: DEFAULT_CLASSIFICATION_SETTINGS,
};

// What a light plan step runs on when the coding role's lightModel is unset
// (agents/model-routing.ts). '' for ollama — there's no way to know which
// smaller model is installed there, so light routing stays off until the
// human picks one in Settings.
export const DEFAULT_LIGHT_MODEL: Record<Provider, string> = {
  claude: 'claude-haiku-4-5',
  anthropic: 'claude-haiku-4-5',
  openai: 'gpt-4.1-mini',
  google: 'gemini-2.5-flash',
  ollama: '',
};

// A starting point for the UI's model picker — not a restriction. Any
// provider accepts an arbitrary model ID string; this just saves typing for
// the common case and gets updated less often than providers ship models.
// ollama is empty here on purpose: its suggestions are fetched live from the
// endpoint (GET /api/settings/ollama/models), since they're whatever the
// human has installed on this machine.
export const KNOWN_MODELS: Record<Provider, string[]> = {
  claude: ['claude-opus-5', 'claude-sonnet-5', 'claude-fable-5-1', 'claude-fable-5', 'claude-haiku-4-5'],
  anthropic: [
    'claude-opus-5',
    'claude-sonnet-5',
    'claude-fable-5-1',
    'claude-fable-5',
    'claude-haiku-4-5',
    'claude-opus-4-5',
  ],
  openai: ['gpt-5.1', 'gpt-5.1-chat-latest', 'gpt-4.1', 'gpt-4o', 'gpt-4o-mini', 'o3'],
  google: ['gemini-3-pro-preview', 'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'],
  ollama: [],
};

// Same shape as JiraSettings but with apiToken swapped for a presence flag —
// the token itself is never sent back to the browser, same treatment as
// provider API keys above.
export type RedactedJiraSettings = Omit<JiraSettings, 'apiToken'> & { hasToken: boolean };

export interface RedactedSettings {
  credentials: Record<Provider, { hasKey: boolean }>;
  models: Record<Role, RoleModelConfig>;
  knownModels: Record<Provider, string[]>;
  defaultLightModels: Record<Provider, string>;
  localModel: LocalModelStatus;
  ollamaEndpoint: string;
  jira: RedactedJiraSettings;
  classification: ClassificationSettings;
  // The picker's options travel with the settings, same as knownModels above,
  // so the UI never hard-codes the model list. On-disk cache status is *not*
  // here — it's read separately via GET /api/settings/classification-cache,
  // since it hits the filesystem and changes independently of settings.
  classificationModels: ClassificationModelOption[];
}

export function redactSettings(settings: HarnessSettings): RedactedSettings {
  const { apiToken, ...jiraRest } = settings.jira;
  return {
    credentials: Object.fromEntries(
      PROVIDERS.map((p) => [p, { hasKey: providerNeedsApiKey(p) ? Boolean(settings.credentials[p]?.trim()) : true }]),
    ) as Record<Provider, { hasKey: boolean }>,
    models: settings.models,
    knownModels: KNOWN_MODELS,
    defaultLightModels: DEFAULT_LIGHT_MODEL,
    localModel: localModelStatus(),
    ollamaEndpoint: settings.ollamaEndpoint,
    jira: { ...jiraRest, hasToken: Boolean(apiToken.trim()) },
    classification: settings.classification,
    classificationModels: CLASSIFICATION_MODELS,
  };
}
