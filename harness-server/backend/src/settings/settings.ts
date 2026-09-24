export type Provider = 'claude' | 'anthropic' | 'openai' | 'google';

// The three providers that authenticate with a pasted API key, run through
// the AI-SDK engine — as opposed to "claude", which authenticates via
// `claude login` and runs through the Claude Agent SDK engine instead.
export type ApiKeyProvider = Exclude<Provider, 'claude'>;

export const PROVIDERS: Provider[] = ['claude', 'anthropic', 'openai', 'google'];

export function isProvider(value: string): value is Provider {
  return (PROVIDERS as string[]).includes(value);
}

// "claude" authenticates via `claude login` (a Pro/Max subscription, OAuth,
// billed against that plan) rather than a pasted API key — the only
// provider here that works that way. Everything else needs a stored key.
export function providerNeedsApiKey(provider: Provider): provider is ApiKeyProvider {
  return provider !== 'claude';
}

export interface RoleModelConfig {
  provider: Provider;
  model: string;
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

export interface HarnessSettings {
  credentials: Partial<Record<Provider, string>>;
  models: Record<Role, RoleModelConfig>;
  jira: JiraSettings;
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
  jira: DEFAULT_JIRA_SETTINGS,
};

// A starting point for the UI's model picker — not a restriction. Any
// provider accepts an arbitrary model ID string; this just saves typing for
// the common case and gets updated less often than providers ship models.
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
};

// Same shape as JiraSettings but with apiToken swapped for a presence flag —
// the token itself is never sent back to the browser, same treatment as
// provider API keys above.
export type RedactedJiraSettings = Omit<JiraSettings, 'apiToken'> & { hasToken: boolean };

export interface RedactedSettings {
  credentials: Record<Provider, { hasKey: boolean }>;
  models: Record<Role, RoleModelConfig>;
  knownModels: Record<Provider, string[]>;
  jira: RedactedJiraSettings;
}

export function redactSettings(settings: HarnessSettings): RedactedSettings {
  const { apiToken, ...jiraRest } = settings.jira;
  return {
    credentials: Object.fromEntries(
      PROVIDERS.map((p) => [p, { hasKey: providerNeedsApiKey(p) ? Boolean(settings.credentials[p]?.trim()) : true }])
    ) as Record<Provider, { hasKey: boolean }>,
    models: settings.models,
    knownModels: KNOWN_MODELS,
    jira: { ...jiraRest, hasToken: Boolean(apiToken.trim()) },
  };
}
