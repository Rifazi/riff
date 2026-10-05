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

/** A document every agent can read without it being re-attached — see harness-server's sessions/reference-docs.ts. */
export interface ReferenceDoc {
  id: string;
  name: string;
  chars: number;
  addedAt: string;
  scope: 'app' | 'session';
  /** What the agents read it by, e.g. reference/session/api-spec-pdf.md. */
  path: string;
}

export type CodingStepStatus = 'pending' | 'in_progress' | 'done';

export interface CodingPlanStep {
  id: string;
  title: string;
  status: CodingStepStatus;
  /** What to do, on a step the lead added after the plan (e.g. a QA fix). */
  brief?: string;
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
  // Read from the repo's theme/theme.json; null when it has no theme.
  theme: AppThemeSummary | null;
}

export interface AppThemeSummary {
  name: string;
  basedOn: string | null;
  // Differs from the preset it started from (or started from none).
  customized: boolean;
  // False when theme.json was hand-edited and the CSS not regenerated yet.
  inSync: boolean;
}

// What setup did on disk, in plain words, and what it couldn't do.
export interface SetupSteps {
  actions: string[];
  warnings: string[];
}

// What adding an app (or pointing it at a new folder) set up on disk.
export interface AppWriteResult extends AppConfig {
  docsInitialized: boolean;
  // Absent when an update didn't change the repository path.
  git?: SetupSteps & { baseBranch: string };
  // Only when a theme was picked while adding the app.
  themeResult?: SetupSteps;
}

export type ThemeMode = 'light' | 'dark';

export interface ThemeColors {
  bg: string;
  surface: string;
  surfaceMuted: string;
  border: string;
  text: string;
  textMuted: string;
  primary: string;
  onPrimary: string;
  success: string;
  warning: string;
  danger: string;
  info: string;
}

export type Density = 'compact' | 'comfortable' | 'spacious';

// Mirrors harness-server's ThemeDefinition: what an app's theme/theme.json holds.
export interface ThemeDefinition {
  name: string;
  description: string;
  fonts: { sans: string; heading: string; mono: string };
  headingWeight: number;
  radius: { sm: number; md: number; lg: number; full: number };
  borderWidth: number;
  shadow: { sm: string; md: string };
  density: Density;
  light: ThemeColors;
  dark: ThemeColors;
}

// The CSS custom properties a theme sets in each mode, rendered server-side
// by the same code that writes the app's tokens.css.
export type ThemeTokens = Record<ThemeMode, Record<string, string>>;

export interface ThemePreset {
  id: string;
  theme: ThemeDefinition;
  tokens: ThemeTokens;
}

export interface ThemesResponse {
  presets: ThemePreset[];
  // The shared ui-* component rules, scoped to [data-ui-theme]: the same
  // CSS a saved theme writes to the repo.
  componentsCss: string;
}

export interface AppThemeState {
  current: { theme: ThemeDefinition; basedOn: string | null; inSync: boolean; tokens: ThemeTokens } | null;
  // Set when theme.json exists but doesn't hold a valid theme.
  error: string | null;
}

// A theme being picked or edited, before it's saved to an app.
export interface ThemeDraft {
  theme: ThemeDefinition;
  basedOn: string | null;
}

export interface ThemeProposal extends ThemeDraft {
  summary: string;
  proposedAt: string;
}

// How far an app's code has adopted its theme; the same facts the agents'
// audit_theme tool reports.
export interface ThemeAudit {
  theme: { name: string; inSync: boolean } | null;
  importedFrom: string[];
  hardCoded: { total: number; byFile: { file: string; count: number; samples: { line: number; text: string }[] }[] };
  legacyTokens: { file: string; names: string[] }[];
  collisions: { file: string; names: string[] }[];
  tailwind: { file: string; usesThemeTokens: boolean }[];
  componentLibraries: string[];
  scannedFiles: number;
  truncated: boolean;
}

export type ThemeApplyResult = SetupSteps & { theme: AppThemeSummary };

export interface SessionMeetingSource {
  /** "journal" when started from a Riff journal; absent = one meeting. */
  kind?: 'meeting' | 'journal';
  /** The meeting id, or the journal id when kind is "journal". */
  meetingId: string;
  meetingTitle: string;
  meetingDate: string | null;
  transcriptPath: string;
  includesSummary: boolean;
}

export interface MeetingSourceInput {
  /** "journal": `transcript` holds the journal's notes and excerpts, `summary` its overview. */
  kind?: 'meeting' | 'journal';
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

/** A group of checklist steps one coding-team member builds in parallel with the others. */
export interface Workstream {
  id: string;
  title: string;
  stepIds: string[];
  ownedPaths: string[];
  dependsOn: string[];
}

export type TeamMemberStatus = 'waiting' | 'running' | 'merging' | 'merged' | 'failed' | 'blocked';

export interface CodingTeamMember extends Workstream {
  branch: string;
  status: TeamMemberStatus;
  note: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  transcript: TranscriptEntry[];
}

export interface CodingTeamState {
  /** "assigned": the lead split the work and the team hasn't started yet. */
  status: 'assigned' | 'running' | 'done' | 'needs_attention' | 'interrupted';
  /** 1 for the first team; each later split by the lead is the next round. */
  round: number;
  kind: 'plan' | 'qa-fix' | 'follow-up';
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
      via: 'glab' | 'gitlab-push-options' | 'gh' | 'push-only';
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
  codingTeamHistory: CodingTeamState[];

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
  themeProposal: ThemeProposal | null;
  splitInto: string[];
  splitFrom: SessionSplitOrigin | null;
  splitKickoffPending: boolean;

  transcripts: {
    requirements: TranscriptEntry[];
    plan: TranscriptEntry[];
    coding: TranscriptEntry[];
    qa: TranscriptEntry[];
  };

  // Absent on sessions from a server older than usage tracking.
  usage?: Record<'requirements' | 'plan' | 'coding' | 'qa', TokenUsage>;

  createdAt: string;
  updatedAt: string;
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export type AgentEvent =
  | { type: 'assistant_text'; text: string }
  | { type: 'tool_call'; toolCallId: string; name: string; input: unknown }
  | { type: 'tool_result'; toolCallId: string; content: unknown; isError: boolean }
  | { type: 'done'; text: string; isError: boolean }
  | { type: 'error'; message: string }
  | { type: 'coordinator_decision'; action: 'continue' | 'ready'; reason: string }
  | { type: 'continuation'; hop: number; maxHops: number }
  | { type: 'compacted'; contextTokens: number }
  | { type: 'usage'; usage: TokenUsage };

export type Provider = 'claude' | 'anthropic' | 'openai' | 'google' | 'ollama';
export const PROVIDERS: Provider[] = ['claude', 'anthropic', 'openai', 'google', 'ollama'];

// Every provider except "claude" (authenticates via `claude login`) and
// "ollama" (a local, unauthenticated server) needs a stored key.
export function providerNeedsApiKey(provider: Provider): boolean {
  return provider !== 'claude' && provider !== 'ollama';
}

/** A model installed in the system Ollama server, with tool support flagged. */
export interface OllamaModel {
  name: string;
  tools: boolean;
}

export interface RoleModelConfig {
  provider: Provider;
  model: string;
  // Coding only: model for plan steps tagged light. Unset = provider default, '' = off.
  lightModel?: string;
  // Coordinator only: try Riff's built-in local model first. Unset = on.
  useLocalModel?: boolean;
  // Coding only: when non-empty, Jack's automatic solo step turns AND every
  // workstream team member run on this Ollama model. '' = off.
  localTeamModel?: string;
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
  defaultLightModels: Record<Provider, string>;
  localModel: { available: boolean; model: string | null; reason: string | null };
  ollamaEndpoint: string;
  jira: RedactedJiraSettings;
}

/** GET /api/settings/ollama/models — [] plus an error when Ollama is unreachable. */
export interface OllamaModelsResponse {
  models: OllamaModel[];
  error?: string;
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

export type UsageStage = 'requirements' | 'plan' | 'coding' | 'qa';
export type UsageRange = 7 | 30 | 90;

// GET /api/usage (harness-server routes/usage.ts). `estimated` = tokens from
// before per-turn logging began, dated to each stage's last activity.
export interface UsageReport {
  days: UsageRange;
  since: string;
  trackedSince: string | null;
  totals: {
    usage: TokenUsage;
    byStage: Record<UsageStage, TokenUsage>;
    estimated: number;
    sessions: number;
  };
  daily: { date: string; byStage: Record<UsageStage, number>; estimated: number }[];
  // Size of the tool results agents got back, per tool, for turns logged
  // since this was tracked. Absent from older servers.
  toolOutput?: { tool: string; calls: number; chars: number }[];
  sessions: {
    id: string;
    title: string;
    appName: string | null;
    exists: boolean;
    lastAt: string;
    turns: number;
    byStage: Record<UsageStage, number>;
    usage: TokenUsage;
  }[];
}
