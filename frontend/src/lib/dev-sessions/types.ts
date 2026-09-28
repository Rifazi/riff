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
  | 'abandoned'
  | 'split';

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
  baseBranch: string;
  checkCommands: CheckCommands;
  docsDir: string;
  repoUrl: string | null;
}

// What adding an app (or pointing it at a new folder) set up on disk.
export interface AppWriteResult extends AppConfig {
  docsInitialized: boolean;
  // Absent when an update didn't change the repository path.
  git?: { baseBranch: string; actions: string[]; warnings: string[] };
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

export interface SplitPart {
  title: string;
  sessionKey: string;
  brief: string;
  /** Indexes of earlier parts in the same proposal. */
  dependsOn: number[];
}

export interface SplitProposal {
  rationale: string;
  parts: SplitPart[];
  proposedAt: string;
}

export interface SessionSplitOrigin {
  sessionId: string;
  sessionKey: string;
  title: string;
  dependsOnSessionIds: string[];
}

/** A group of plan steps one coding-team member builds in parallel with the others. */
export interface PlanWorkstream {
  id: string;
  title: string;
  stepIds: string[];
  ownedPaths: string[];
  dependsOn: string[];
}

export type TeamMemberStatus = 'waiting' | 'running' | 'merging' | 'merged' | 'failed' | 'blocked';

export interface CodingTeamMember extends PlanWorkstream {
  branch: string;
  status: TeamMemberStatus;
  note: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  transcript: TranscriptEntry[];
}

export interface CodingTeamState {
  status: 'running' | 'done' | 'needs_attention' | 'interrupted';
  members: CodingTeamMember[];
  startedAt: string;
  finishedAt: string | null;
}

export type TeamEvent =
  | { type: 'team_member_event'; memberId: string; event: AgentEvent }
  | { type: 'team_member_status'; memberId: string; status: TeamMemberStatus; note: string | null }
  | { type: 'team_status'; status: 'running' | 'done' | 'needs_attention' }
  | { type: 'error'; message: string };

export interface SessionDelivery {
  kind: 'merged' | 'merge_request' | 'pushed';
  target: string;
  url: string | null;
  detail: string;
  at: string;
}

/** What shipping would do, detected server-side from the repo's remotes. */
export type DeliveryPlan =
  | { kind: 'merge'; branch: string; baseBranch: string; reason: string }
  | {
      kind: 'merge_request';
      branch: string;
      baseBranch: string;
      remote: string;
      remoteUrl: string;
      host: 'github' | 'gitlab' | 'other';
      webUrl: string | null;
      via: 'gitlab-push-options' | 'gh' | 'push-only';
      reason: string;
    };

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
  codingTeam: CodingTeamState | null;

  qaReportPath: string | null;
  delivery: SessionDelivery | null;
  qaStatus: 'pending-review' | 'reviewed' | null;

  coordinatorEnabled: boolean;
  qaFindingsPending: boolean;
  qaRerunPending: boolean;

  reopenedFromCoding: boolean;
  pendingRequirementsRelayNote: string | null;
  requirementsRelayPending: boolean;
  planRelayPending: boolean;
  codingReconciliationPending: boolean;

  sourceMeeting: SessionMeetingSource | null;
  meetingKickoffPending: boolean;

  splitProposal: SplitProposal | null;
  splitInto: string[];
  splitFrom: SessionSplitOrigin | null;
  splitKickoffPending: boolean;

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
