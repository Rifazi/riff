import type {
  AppConfig,
  AppPrompts,
  AppWriteResult,
  CheckCommands,
  CreateJiraTicketsResult,
  DeliveryPlan,
  Integration,
  JiraSettingsFields,
  AttachmentInput,
  MeetingSourceInput,
  PlanStepSummary,
  Provider,
  ReferenceDoc,
  Role,
  RoleModelConfig,
  SessionRecord,
  SettingsResponse,
  AppThemeState,
  ThemeApplyResult,
  ThemeAudit,
  ThemeDefinition,
  ThemeDraft,
  ThemeTokens,
  ThemesResponse,
  UsageRange,
  UsageReport,
} from './types';

// The agent server the Riff desktop app starts alongside itself (see
// src-tauri/src/agent_server.rs). Absolute, since the UI is a static export
// served from the Tauri webview, not from this server.
export const AGENT_SERVER_URL = process.env.NEXT_PUBLIC_AGENT_SERVER_URL ?? 'http://127.0.0.1:4319';

export function apiUrl(path: string): string {
  return `${AGENT_SERVER_URL}${path}`;
}

async function noContent(res: Response): Promise<void> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  getHealth: () => fetch(apiUrl('/api/health')).then((r) => json<{ ok: boolean }>(r)),

  listApps: () => fetch(apiUrl('/api/apps')).then((r) => json<AppConfig[]>(r)),

  validateApp: (repoRoot: string) =>
    fetch(apiUrl('/api/apps/validate'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoRoot }),
    }).then((r) => json<{ ok: boolean; error?: string; note?: string }>(r)),

  createApp: (input: { name: string; repoRoot: string; checkCommands?: CheckCommands; theme?: ThemeDefinition; basedOn?: string | null }) =>
    fetch(apiUrl('/api/apps'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }).then((r) => json<AppWriteResult>(r)),

  updateApp: (id: string, patch: { name?: string; repoRoot?: string; checkCommands?: CheckCommands }) =>
    fetch(apiUrl(`/api/apps/${id}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }).then((r) => json<AppWriteResult>(r)),

  deleteApp: (id: string) =>
    fetch(apiUrl(`/api/apps/${id}`), { method: 'DELETE' }).then(async (r) => {
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error ?? `Request failed: ${r.status}`);
      }
    }),

  listThemes: () => fetch(apiUrl('/api/themes')).then((r) => json<ThemesResponse>(r)),

  previewTheme: (theme: ThemeDefinition) =>
    fetch(apiUrl('/api/themes/preview'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme }),
    }).then((r) => json<{ tokens: ThemeTokens }>(r)),

  getAppTheme: (appId: string) => fetch(apiUrl(`/api/apps/${appId}/theme`)).then((r) => json<AppThemeState>(r)),

  saveAppTheme: (appId: string, draft: ThemeDraft) =>
    fetch(apiUrl(`/api/apps/${appId}/theme`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(draft),
    }).then((r) => json<ThemeApplyResult>(r)),

  getThemeAudit: (appId: string) => fetch(apiUrl(`/api/apps/${appId}/theme/audit`)).then((r) => json<ThemeAudit>(r)),

  regenerateAppTheme: (appId: string) =>
    fetch(apiUrl(`/api/apps/${appId}/theme/regenerate`), { method: 'POST' }).then((r) => json<ThemeApplyResult>(r)),

  applyThemeProposal: (sessionId: string, draft: ThemeDraft) =>
    fetch(apiUrl(`/api/sessions/${sessionId}/theme-proposal/apply`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(draft),
    }).then((r) => json<ThemeApplyResult>(r)),

  dismissThemeProposal: (sessionId: string) =>
    fetch(apiUrl(`/api/sessions/${sessionId}/theme-proposal/dismiss`), { method: 'POST' }).then((r) => json<SessionRecord>(r)),

  getAppPrompts: (id: string) => fetch(apiUrl(`/api/apps/${id}/prompts`)).then((r) => json<AppPrompts>(r)),

  setAppPrompt: (id: string, role: Role, text: string | null) =>
    fetch(apiUrl(`/api/apps/${id}/prompts/${role}`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    }).then((r) => json<{ ok: boolean }>(r)),

  listSessions: (filter?: { meetingId?: string }) =>
    fetch(apiUrl(`/api/sessions${filter?.meetingId ? `?meetingId=${encodeURIComponent(filter.meetingId)}` : ''}`)).then((r) =>
      json<SessionRecord[]>(r)
    ),

  getSession: (id: string) => fetch(apiUrl(`/api/sessions/${id}`)).then((r) => json<SessionRecord>(r)),

  createSession: (input: { title: string; sessionKey?: string; appId: string; source?: MeetingSourceInput }) =>
    fetch(apiUrl('/api/sessions'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }).then((r) => json<SessionRecord>(r)),

  reopenSession: (id: string) =>
    fetch(apiUrl(`/api/sessions/${id}/reopen`), { method: 'POST' }).then((r) => json<SessionRecord>(r)),

  deleteSession: (id: string) =>
    fetch(apiUrl(`/api/sessions/${id}`), { method: 'DELETE' }).then(async (r) => {
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error ?? `Request failed: ${r.status}`);
      }
    }),

  getRequirementsDoc: (id: string) =>
    fetch(apiUrl(`/api/sessions/${id}/requirements/doc`)).then((r) => json<{ markdown: string | null; body: string | null }>(r)),

  updateRequirementsDoc: (id: string, markdownBody: string) =>
    fetch(apiUrl(`/api/sessions/${id}/requirements/doc`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markdownBody }),
    }).then((r) => json<{ markdown: string }>(r)),

  approveRequirements: (id: string) =>
    fetch(apiUrl(`/api/sessions/${id}/requirements/approve`), { method: 'POST' }).then((r) => json<SessionRecord>(r)),

  rejectRequirements: (id: string) =>
    fetch(apiUrl(`/api/sessions/${id}/requirements/reject`), { method: 'POST' }).then((r) => json<SessionRecord>(r)),

  acceptSplit: (id: string) =>
    fetch(apiUrl(`/api/sessions/${id}/requirements/split/accept`), { method: 'POST' }).then((r) =>
      json<{ parent: SessionRecord; children: SessionRecord[] }>(r)
    ),

  dismissSplit: (id: string) =>
    fetch(apiUrl(`/api/sessions/${id}/requirements/split/dismiss`), { method: 'POST' }).then((r) => json<SessionRecord>(r)),

  getPlanDoc: (id: string) =>
    fetch(apiUrl(`/api/sessions/${id}/plan/doc`)).then((r) =>
      json<{
        markdown: string | null;
        body: string | null;
        steps: PlanStepSummary[];
        jira: { epicKey: string; issues: CreateJiraTicketsResult['issues'] } | null;
      }>(
        r
      )
    ),

  updatePlanDoc: (id: string, markdownBody: string) =>
    fetch(apiUrl(`/api/sessions/${id}/plan/doc`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markdownBody }),
    }).then((r) => json<{ markdown: string }>(r)),

  approvePlan: (id: string) => fetch(apiUrl(`/api/sessions/${id}/plan/approve`), { method: 'POST' }).then((r) => json<SessionRecord>(r)),

  rejectPlan: (id: string) => fetch(apiUrl(`/api/sessions/${id}/plan/reject`), { method: 'POST' }).then((r) => json<SessionRecord>(r)),

  createJiraTickets: (id: string) =>
    fetch(apiUrl(`/api/sessions/${id}/plan/jira/create`), { method: 'POST' }).then((r) => json<CreateJiraTicketsResult>(r)),

  getDeliveryPlan: (id: string) => fetch(apiUrl(`/api/sessions/${id}/delivery`)).then((r) => json<DeliveryPlan>(r)),

  deliver: (id: string) => fetch(apiUrl(`/api/sessions/${id}/delivery`), { method: 'POST' }).then((r) => json<SessionRecord>(r)),

  getTeamStatus: (id: string) =>
    fetch(apiUrl(`/api/sessions/${id}/coding/team`)).then((r) => json<{ running: boolean }>(r)),

  getCodingDiff: (id: string) =>
    fetch(apiUrl(`/api/sessions/${id}/coding/diff`)).then((r) =>
      json<{ diff: string | null; stat: string | null; commits: { hash: string; message: string; date: string }[] }>(r)
    ),

  approveCoding: (id: string) =>
    fetch(apiUrl(`/api/sessions/${id}/coding/approve`), { method: 'POST' }).then((r) => json<SessionRecord>(r)),

  rejectCoding: (id: string) =>
    fetch(apiUrl(`/api/sessions/${id}/coding/reject`), { method: 'POST' }).then((r) => json<SessionRecord>(r)),

  sendBackToRequirements: (id: string, note: string) =>
    fetch(apiUrl(`/api/sessions/${id}/coding/send-back-to-requirements`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note }),
    }).then((r) => json<SessionRecord>(r)),

  getQaReport: (id: string) =>
    fetch(apiUrl(`/api/sessions/${id}/qa/report`)).then((r) => json<{ markdown: string | null }>(r)),

  getQaFindings: (id: string) =>
    fetch(apiUrl(`/api/sessions/${id}/qa/findings`)).then((r) => json<{ text: string | null }>(r)),

  approveQa: (id: string) =>
    fetch(apiUrl(`/api/sessions/${id}/qa/approve`), { method: 'POST' }).then((r) => json<SessionRecord>(r)),

  rejectQa: (id: string) =>
    fetch(apiUrl(`/api/sessions/${id}/qa/reject`), { method: 'POST' }).then((r) => json<SessionRecord>(r)),

  sendQaBack: (id: string) =>
    fetch(apiUrl(`/api/sessions/${id}/qa/send-back`), { method: 'POST' }).then((r) => json<SessionRecord>(r)),

  getSettings: () => fetch(apiUrl('/api/settings')).then((r) => json<SettingsResponse>(r)),

  getUsage: (days: UsageRange) => fetch(apiUrl(`/api/usage?days=${days}`)).then((r) => json<UsageReport>(r)),

  updateSettings: (patch: {
    credentials?: Partial<Record<Provider, string | null>>;
    models?: Partial<Record<Role, RoleModelConfig>>;
    jira?: Partial<JiraSettingsFields> & { apiToken?: string | null };
  }) =>
    fetch(apiUrl('/api/settings'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }).then((r) => json<SettingsResponse>(r)),

  testCredential: (input: { provider: Provider; apiKey?: string; model?: string }) =>
    fetch(apiUrl('/api/settings/test'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }).then((r) => json<{ ok: boolean; error?: string }>(r)),

  testJiraConnection: (input: Partial<JiraSettingsFields> & { apiToken?: string }) =>
    fetch(apiUrl('/api/settings/jira/test'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }).then((r) => json<{ ok: boolean; error?: string }>(r)),

  toggleCoordinator: (id: string, enabled: boolean) =>
    fetch(apiUrl(`/api/sessions/${id}/coordinator/toggle`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    }).then((r) => json<SessionRecord>(r)),

  listAppReferenceDocs: (appId: string) =>
    fetch(apiUrl(`/api/apps/${appId}/reference-docs`)).then((r) => json<ReferenceDoc[]>(r)),

  addAppReferenceDocs: (appId: string, attachments: AttachmentInput[]) =>
    fetch(apiUrl(`/api/apps/${appId}/reference-docs`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ attachments }),
    }).then((r) => json<ReferenceDoc[]>(r)),

  removeAppReferenceDoc: (appId: string, docId: string) =>
    fetch(apiUrl(`/api/apps/${appId}/reference-docs/${docId}`), { method: 'DELETE' }).then(noContent),

  listSessionReferenceDocs: (id: string) =>
    fetch(apiUrl(`/api/sessions/${id}/reference-docs`)).then((r) => json<{ app: ReferenceDoc[]; session: ReferenceDoc[] }>(r)),

  addSessionReferenceDocs: (id: string, attachments: AttachmentInput[]) =>
    fetch(apiUrl(`/api/sessions/${id}/reference-docs`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ attachments }),
    }).then((r) => json<ReferenceDoc[]>(r)),

  removeSessionReferenceDoc: (id: string, docId: string) =>
    fetch(apiUrl(`/api/sessions/${id}/reference-docs/${docId}`), { method: 'DELETE' }).then(noContent),

  shareReferenceDocWithApp: (id: string, docId: string) =>
    fetch(apiUrl(`/api/sessions/${id}/reference-docs/${docId}/share`), { method: 'POST' }).then((r) => json<ReferenceDoc>(r)),

  listIntegrations: (appId: string) => fetch(apiUrl(`/api/apps/${appId}/integrations`)).then((r) => json<Integration[]>(r)),

  getIntegrationDoc: (appId: string, path: string) =>
    fetch(apiUrl(`/api/apps/${appId}/integrations/doc?path=${encodeURIComponent(path)}`)).then((r) => json<{ markdown: string }>(r)),
};
