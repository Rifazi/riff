export type SessionStage =
  | 'requirements-in-progress'
  | 'requirements-approved'
  | 'plan-in-progress'
  | 'plan-approved'
  | 'coding-in-progress'
  | 'coding-review'
  | 'qa-in-progress'
  | 'qa-reviewed'
  | 'done'
  | 'abandoned';

export type TranscriptRole = 'user' | 'assistant' | 'tool_call' | 'tool_result' | 'system';

export interface TranscriptEntry {
  id: string;
  role: TranscriptRole;
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: unknown;
  isError?: boolean;
  timestamp: string;
}

/** A file staged in the chat composer, ready to send — base64, no `data:` prefix. */
export interface AttachmentInput {
  name: string;
  mediaType: string;
  data: string;
}

export type CodingStepStatus = 'pending' | 'in_progress' | 'done';

export interface CodingPlanStep {
  id: string;
  title: string;
  status: CodingStepStatus;
}

export interface CheckCommands {
  lint?: string;
  test?: string;
  'test:integration'?: string;
}

export interface AppConfig {
  id: string;
  name: string;
  repoRoot: string;
  checkCommands: CheckCommands;
  docsDir: string;
  repoUrl: string | null;
}

export interface SessionMeetingSource {
  meetingId: string;
  meetingTitle: string;
  meetingDate: string | null;
  transcriptPath: string;
  includesSummary: boolean;
}

export interface MeetingSourceInput {
  meetingId: string;
  meetingTitle: string;
  meetingDate?: string | null;
  transcript: string;
  summary?: string | null;
}

export interface SessionRecord {
  id: string;
  sessionKey: string;
  title: string;
  stage: SessionStage;
  appId: string;
  appName: string;

  requirementsPath: string | null;
  requirementsStatus: 'draft' | 'approved' | 'superseded' | null;

  planPath: string | null;
  planStatus: 'draft' | 'approved' | 'superseded' | null;

  branch: string | null;
  codingApprovedAt: string | null;
  codingPlan: CodingPlanStep[] | null;

  qaReportPath: string | null;
  qaStatus: 'pending-review' | 'reviewed' | null;

  coordinatorEnabled: boolean;
  qaFindingsPending: boolean;

  reopenedFromCoding: boolean;
  pendingRequirementsRelayNote: string | null;
  requirementsRelayPending: boolean;
  planRelayPending: boolean;
  codingReconciliationPending: boolean;

  sourceMeeting: SessionMeetingSource | null;
  meetingKickoffPending: boolean;

  transcripts: {
    requirements: TranscriptEntry[];
    plan: TranscriptEntry[];
    coding: TranscriptEntry[];
    qa: TranscriptEntry[];
  };

  createdAt: string;
  updatedAt: string;
}

export type AgentEvent =
  | { type: 'assistant_text'; text: string }
  | { type: 'tool_call'; toolCallId: string; name: string; input: unknown }
  | { type: 'tool_result'; toolCallId: string; content: unknown; isError: boolean }
  | { type: 'done'; text: string; isError: boolean }
  | { type: 'error'; message: string }
  | { type: 'coordinator_decision'; action: 'continue' | 'ready'; reason: string }
  | { type: 'continuation'; hop: number; maxHops: number };

export type Provider = 'claude' | 'anthropic' | 'openai' | 'google';
export const PROVIDERS: Provider[] = ['claude', 'anthropic', 'openai', 'google'];

// Every provider except "claude" (which authenticates via `claude login`
// instead of a pasted API key) needs a stored key.
export function providerNeedsApiKey(provider: Provider): boolean {
  return provider !== 'claude';
}

export interface RoleModelConfig {
  provider: Provider;
  model: string;
}

export type Role = 'requirements' | 'plan' | 'coding' | 'qa' | 'coordinator';

export interface JiraSettingsFields {
  baseUrl: string;
  email: string;
  issueType: string;
  epicLinkFieldId: string;
}

export interface RedactedJiraSettings extends JiraSettingsFields {
  hasToken: boolean;
}

export interface SettingsResponse {
  credentials: Record<Provider, { hasKey: boolean }>;
  models: Record<Role, RoleModelConfig>;
  knownModels: Record<Provider, string[]>;
  jira: RedactedJiraSettings;
}

export interface JiraTicketRef {
  stepId: string;
  title: string;
  key: string;
  url: string;
}

export interface JiraTicketError {
  stepId: string;
  title: string;
  message: string;
}

export interface JiraPlanRecord {
  epicKey: string;
  issues: JiraTicketRef[];
}

export interface CreateJiraTicketsResult extends JiraPlanRecord {
  errors: JiraTicketError[];
}

export interface PlanStepSummary {
  id: string;
  title: string;
}

export interface IntegrationDoc {
  file: string;
  title: string;
}

export interface Integration {
  slug: string;
  title: string;
  summary: string;
  readmePath: string;
  docs: IntegrationDoc[];
}

export interface RolePrompt {
  base: string | null;
  override: string | null;
}

export type AppPrompts = Record<Role, RolePrompt>;
