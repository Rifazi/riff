import type { JiraSettings } from '../settings/settings.js';
import { markdownToAdf } from './markdown-to-adf.js';

export class JiraError extends Error {}

function requireConfigured(settings: JiraSettings): void {
  if (!settings.baseUrl.trim() || !settings.email.trim() || !settings.apiToken.trim()) {
    throw new JiraError('Jira is not fully configured — set the base URL, email, and API token in Settings first.');
  }
}

// Jira issue keys are always "<PROJECT KEY>-<number>", and project keys
// themselves can't contain a hyphen — so the project a new ticket belongs
// to can always be read straight off the epic key it's being linked to,
// rather than asking for it separately.
function projectKeyFromIssueKey(issueKey: string): string {
  const projectKey = issueKey.split('-')[0];
  if (!projectKey) throw new JiraError(`Could not determine a project key from epic "${issueKey}".`);
  return projectKey;
}

function apiBase(settings: JiraSettings): string {
  return settings.baseUrl.trim().replace(/\/+$/, '') + '/rest/api/3';
}

function authHeader(settings: JiraSettings): string {
  return 'Basic ' + Buffer.from(`${settings.email.trim()}:${settings.apiToken.trim()}`).toString('base64');
}

async function jiraFetch(settings: JiraSettings, pathAndQuery: string, init?: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${apiBase(settings)}${pathAndQuery}`, {
      ...init,
      headers: {
        Authorization: authHeader(settings),
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...init?.headers,
      },
    });
  } catch (err) {
    throw new JiraError(`Could not reach ${settings.baseUrl} — check the base URL. (${err instanceof Error ? err.message : String(err)})`);
  }
  return response;
}

async function jiraErrorMessage(response: Response): Promise<string> {
  const body = await response.text();
  try {
    const parsed = JSON.parse(body) as { errorMessages?: string[]; errors?: Record<string, string> };
    const parts = [...(parsed.errorMessages ?? []), ...Object.values(parsed.errors ?? {})];
    if (parts.length > 0) return parts.join('; ');
  } catch {
    // not JSON — fall through to raw body
  }
  return body || `HTTP ${response.status}`;
}

export async function testJiraConnection(settings: JiraSettings): Promise<void> {
  requireConfigured(settings);
  const response = await jiraFetch(settings, '/myself');
  if (!response.ok) {
    if (response.status === 401) throw new JiraError('Authentication failed — check the email and API token.');
    throw new JiraError(`Connection test failed: ${await jiraErrorMessage(response)}`);
  }
}

// Reads the Epic that an existing issue (e.g. this session's own ticket key)
// belongs to. Team-managed ("next-gen") Jira Cloud projects expose this via
// the standard `parent` field; classic (company-managed) projects only
// expose it via a project-specific custom field, so this falls back to
// `settings.epicLinkFieldId` when `parent` isn't present. If the session's
// own ticket key is itself an Epic (rather than a story/task under one),
// it IS the epic to link plan tickets to — there's nothing to look up.
export async function getEpicKeyForIssue(settings: JiraSettings, issueKey: string): Promise<string> {
  requireConfigured(settings);
  const fields = ['issuetype', 'parent', ...(settings.epicLinkFieldId ? [settings.epicLinkFieldId] : [])];
  const response = await jiraFetch(settings, `/issue/${encodeURIComponent(issueKey)}?fields=${fields.join(',')}`);
  if (response.status === 404) {
    throw new JiraError(
      `Jira has no issue "${issueKey}" (this session's key) — create it there first and attach it to an epic, ` +
        `or check that the base URL in Settings points at the right site.`
    );
  }
  if (!response.ok) {
    throw new JiraError(`Could not look up ${issueKey}: ${await jiraErrorMessage(response)}`);
  }
  const data = (await response.json()) as { fields?: Record<string, unknown> };

  const issueType = data.fields?.issuetype as { name?: string } | undefined;
  if (issueType?.name?.toLowerCase() === 'epic') return issueKey;

  const parent = data.fields?.parent as { key?: string } | undefined;
  if (parent?.key) return parent.key;

  if (settings.epicLinkFieldId) {
    const epicLinkValue = data.fields?.[settings.epicLinkFieldId];
    if (typeof epicLinkValue === 'string' && epicLinkValue) return epicLinkValue;
  }

  throw new JiraError(
    `${issueKey} isn't linked to an epic in Jira. If this is a classic (company-managed) project, the epic link ` +
      `lives in a custom field — set "Epic link field ID" in Settings (find it via ` +
      `${settings.baseUrl.replace(/\/+$/, '')}/rest/api/3/field, looking for a field named "Epic Link").`
  );
}

export interface CreateJiraIssueInput {
  summary: string;
  descriptionMarkdown: string;
  epicKey: string;
}

export interface JiraIssueRef {
  key: string;
  url: string;
}

export async function createJiraIssue(settings: JiraSettings, input: CreateJiraIssueInput): Promise<JiraIssueRef> {
  requireConfigured(settings);
  const description = markdownToAdf(input.descriptionMarkdown);

  const projectKey = projectKeyFromIssueKey(input.epicKey);

  const attemptCreate = async (parentField: 'parent' | 'custom'): Promise<Response> =>
    jiraFetch(settings, '/issue', {
      method: 'POST',
      body: JSON.stringify({
        fields: {
          project: { key: projectKey },
          issuetype: { name: settings.issueType.trim() || 'Task' },
          summary: input.summary,
          description,
          ...(parentField === 'parent'
            ? { parent: { key: input.epicKey } }
            : settings.epicLinkFieldId
              ? { [settings.epicLinkFieldId]: input.epicKey }
              : {}),
        },
      }),
    });

  let response = await attemptCreate('parent');
  if (!response.ok && settings.epicLinkFieldId) {
    // `parent` isn't a valid field on classic projects — retry once via the
    // configured Epic Link custom field instead of surfacing that error.
    const firstError = await jiraErrorMessage(response.clone());
    if (/parent/i.test(firstError)) {
      response = await attemptCreate('custom');
    }
  }

  if (!response.ok) {
    throw new JiraError(`Failed to create "${input.summary}": ${await jiraErrorMessage(response)}`);
  }

  const created = (await response.json()) as { key: string };
  const url = `${settings.baseUrl.trim().replace(/\/+$/, '')}/browse/${created.key}`;
  return { key: created.key, url };
}
