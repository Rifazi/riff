import type { ModelMessage } from 'ai';
import type { TokenUsage } from '../agents/sdk-client.js';
import type { ThemeDefinition } from '../themes/presets.js';

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
  // Terminal: the requirements agent judged this feature too big for one
  // pass, the human accepted its proposal, and the work now lives in the
  // child sessions listed in splitInto.
  | 'split';

export type TranscriptRole = 'user' | 'assistant' | 'tool_call' | 'tool_result' | 'system';

export type CodingStepStatus = 'pending' | 'in_progress' | 'done';

export interface CodingPlanStep {
  id: string;
  title: string;
  status: CodingStepStatus;
}

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

// The Riff meeting a session was started from, when it was created from a
// transcript rather than a typed prompt. The transcript itself lives under
// state/ (gitignored — meeting content is private), not in artifacts/.
export interface SessionMeetingSource {
  meetingId: string;
  meetingTitle: string;
  meetingDate: string | null;
  transcriptPath: string; // harnessRoot-relative
  includesSummary: boolean;
}

// One independently shippable slice of a feature the requirements agent
// proposed splitting (see tool-defs/propose-split-tool.ts).
export interface SplitPart {
  title: string;
  sessionKey: string;
  // Self-contained markdown handed to the child session's requirements
  // agent as its starting point — it never sees the parent's conversation.
  brief: string;
  // Indexes into the same parts array — each only ever points at an
  // earlier part, so the order is also a valid build order.
  dependsOn: number[];
}

export interface SplitProposal {
  rationale: string;
  parts: SplitPart[];
  proposedAt: string;
}

// A theme the requirements agent suggested (propose_theme). Like a split,
// it only ever becomes real when the human applies it from the theme
// picker, possibly after editing it there.
export interface ThemeProposal {
  theme: ThemeDefinition;
  basedOn: string | null;
  summary: string;
  proposedAt: string;
}

export interface SessionSplitOrigin {
  sessionId: string;
  sessionKey: string;
  title: string;
  // Sibling session ids this part depends on, resolved from
  // SplitPart.dependsOn at split time.
  dependsOnSessionIds: string[];
}

// A group of plan steps one coding-team member implements, concurrently
// with the others, in its own git worktree (see agents/team/). Declared by
// the plan agent in write_plan_doc; validated by sessions/plan-doc.ts so no
// two workstreams can write the same path.
export interface PlanWorkstream {
  id: string;
  title: string;
  stepIds: string[];
  // Repo-relative files or directories this member may write — nobody else
  // may write inside them.
  ownedPaths: string[];
  // Workstream ids that must be merged before this one starts.
  dependsOn: string[];
}

export type TeamMemberStatus = 'waiting' | 'running' | 'merging' | 'merged' | 'failed' | 'blocked';

export interface CodingTeamMember extends PlanWorkstream {
  branch: string;
  status: TeamMemberStatus;
  // Why it failed or is blocked, or a note about the merge.
  note: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  transcript: TranscriptEntry[];
  history: ModelMessage[];
  claudeSessionId: string | null;
}

export interface CodingTeamState {
  // "interrupted" = the server stopped mid-run (set at boot); the run
  // endpoint resumes every member that hasn't merged yet.
  status: 'running' | 'done' | 'needs_attention' | 'interrupted';
  members: CodingTeamMember[];
  startedAt: string;
  finishedAt: string | null;
}

export interface SessionRecord {
  id: string;
  sessionKey: string; // e.g. "API-1234" or a kebab-slug — shared across requirements doc, branch, QA report
  title: string;
  stage: SessionStage;

  // Which target app (apps/apps-store.ts) this session drives — its
  // repoRoot/docs are what every repo-touching tool call resolves against.
  // Sessions created before multi-app support get defaulted to the legacy
  // seeded app on read (see session-store.ts's normalizeSession).
  appId: string;

  requirementsPath: string | null;
  requirementsStatus: 'draft' | 'approved' | 'superseded' | null;

  // The reviewable step-by-step plan, written by the plan agent from the
  // approved requirements doc — approved here before any code gets
  // written. Same shape/lifecycle as requirementsPath/requirementsStatus.
  planPath: string | null;
  planStatus: 'draft' | 'approved' | 'superseded' | null;

  branch: string | null;
  codingApprovedAt: string | null;
  // The coding agent's live checklist for this feature (see
  // tool-defs/coding-plan-tool.ts) — seeded from the approved plan doc's
  // steps, then updated as each step is completed. Null until the agent
  // calls write_coding_plan.
  codingPlan: CodingPlanStep[] | null;
  // Set when the approved plan had 2+ workstreams and the team was started
  // — the members' own transcripts live here, not in transcripts.coding
  // (which stays the lead's single-agent chat for follow-ups after merge).
  codingTeam: CodingTeamState | null;

  qaReportPath: string | null;
  // How the reviewed branch was shipped (repo/delivery.ts): merged into the
  // base branch for a local-only repo, or pushed with an MR/PR opened.
  delivery: { kind: 'merged' | 'merge_request' | 'pushed'; target: string; url: string | null; detail: string; at: string } | null;
  qaStatus: 'pending-review' | 'reviewed' | null;
  // Set when a QA report is sent back to Coding for fixes instead of being
  // marked reviewed — true until the next coding message is sent, at which
  // point CodingStage has relayed the findings and this clears itself.
  qaFindingsPending: boolean;

  // Set when coding is re-approved after a send-back and QA already has a
  // conversation — QaStage (or the coordinator) sends a re-review message
  // instead of waiting for an empty transcript, and the next QA turn clears it.
  qaRerunPending: boolean;

  // Opt-in, per-session: when true, an SSE run against
  // /coordinator/run drives a stage's conversation forward automatically
  // (composing follow-up messages, deciding when a stage looks ready) and
  // auto-starts the next stage after a human approval. It never approves
  // or rejects anything itself. Off by default.
  coordinatorEnabled: boolean;

  // Set once, permanently, by coding/send-back-to-requirements — this
  // session's requirements/plan were revised after coding had already
  // produced a branch. Never cleared, even after the round trip completes,
  // so the requirements/plan agents and UI can keep framing this as a
  // revision of partially-built work rather than a from-scratch run.
  reopenedFromCoding: boolean;
  // The human's rationale for sending coding back to requirements, kept
  // verbatim so it can be relayed as the opening message of each stage it
  // passes back through. Overwritten (not appended) on a repeat cycle.
  pendingRequirementsRelayNote: string | null;
  // One-shot relay flags, mirroring qaFindingsPending below: each is set
  // when the round trip reaches that stage and cleared the moment that
  // stage's next message is sent, so the note only auto-fires once.
  requirementsRelayPending: boolean;
  planRelayPending: boolean;
  codingReconciliationPending: boolean;

  sourceMeeting: SessionMeetingSource | null;
  // One-shot, same lifecycle as requirementsRelayPending: true from creation
  // until the first requirements message, which is when the meeting
  // transcript gets attached to the turn server-side.
  meetingKickoffPending: boolean;

  // Pending until the human accepts or dismisses it in the UI — the agent
  // can only propose a split, never perform one (same rule as approvals).
  splitProposal: SplitProposal | null;
  // Set on the parent once a split is accepted.
  splitInto: string[];
  // Set on each child created by a split.
  splitFrom: SessionSplitOrigin | null;
  // The accepted part's brief, attached to the child's first requirements
  // message — one-shot, same lifecycle as meetingKickoffPending.
  splitBrief: string | null;
  splitKickoffPending: boolean;

  // Pending until the human applies or dismisses it in the theme picker.
  themeProposal: ThemeProposal | null;
  // Which theme (a theme.json fingerprint, or "none") each stage's agent was
  // last briefed on, so a mid-session theme change re-briefs it next turn.
  themeContextSeen: Partial<Record<'plan' | 'coding' | 'qa', string>>;

  // Human-readable, for the UI's chat panes.
  transcripts: {
    requirements: TranscriptEntry[];
    plan: TranscriptEntry[];
    coding: TranscriptEntry[];
    qa: TranscriptEntry[];
  };

  // Raw provider message history, for feeding back into the next turn's
  // streamText call — provider-agnostic, unlike the old opaque SDK session
  // ID this replaced, so it works identically no matter which model a role
  // is configured to use, and survives switching providers mid-session.
  histories: {
    requirements: ModelMessage[];
    plan: ModelMessage[];
    coding: ModelMessage[];
    qa: ModelMessage[];
  };

  // Used only for a stage that ran on the "claude" provider (subscription
  // login via the Claude Agent SDK) instead of the AI-SDK engine above —
  // that engine resumes its own server-side session by ID rather than a
  // replayed message array. A stage only ever has one or the other
  // populated, whichever engine its last turn actually ran on.
  claudeSessionIds: {
    requirements: string | null;
    plan: string | null;
    coding: string | null;
    qa: string | null;
  };

  // Running token totals per stage (team members count toward coding), so
  // the cost of each stage is visible and changes to it measurable.
  usage: {
    requirements: TokenUsage;
    plan: TokenUsage;
    coding: TokenUsage;
    qa: TokenUsage;
  };

  createdAt: string;
  updatedAt: string;
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}
