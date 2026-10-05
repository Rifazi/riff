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
  // What to do, for a step that isn't in the approved plan: the lead writes
  // one per step it adds when it splits follow-up work (e.g. QA's findings)
  // across a team (tool-defs/assign-team-tool.ts).
  brief?: string;
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
  // A system entry recording one `delegate` call: what its local helpers
  // read, handed back and saved (agents/tool-defs/delegate-tool.ts).
  delegate?: DelegateRunStats;
}

export interface DelegateRunStats {
  model: string;
  tasks: number;
  useful: number;
  readChars: number;
  returnedChars: number;
  savedTokens: number;
  localTokens: number;
}

// The Riff meeting a session was started from, when it was created from a
// transcript rather than a typed prompt. The transcript itself lives under
// state/ (gitignored — meeting content is private), not in artifacts/.
export interface SessionMeetingSource {
  /** "journal" when the source is a Riff journal (overview + notes from many meetings); absent = one meeting. */
  kind?: 'meeting' | 'journal';
  /** The meeting id, or the journal id when kind is "journal". */
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

// A group of checklist steps one coding-team member implements,
// concurrently with the others, in its own git worktree (see agents/team/).
// Declared by the coding lead with assign_team; validated by
// agents/team/workstreams.ts so no two workstreams can write the same path.
export interface Workstream {
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

export interface CodingTeamMember extends Workstream {
  branch: string;
  status: TeamMemberStatus;
  // Why it failed or is blocked, or a note about the merge.
  note: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  transcript: TranscriptEntry[];
  history: ModelMessage[];
  claudeSessionId: string | null;
  // The transcript entry the member's current conversation started after
  // (agents/handoff.ts) — null = the start of its transcript.
  contextStartEntryId?: string | null;
  // When set, this member runs on Ollama with this model ID rather than the
  // coding role's configured provider/model (see settings.ts localTeamModel).
  localModel?: string | null;
}

export interface CodingContext {
  stepId: string | null;
  startEntryId: string | null;
  tokens: number;
  // The last team round this conversation saw finish; a round finishing
  // after it starts the lead's next turn in a new conversation.
  teamRound?: number;
}

// Why the lead split work across a team: the approved plan at kickoff, QA's
// findings after a send-back, or anything else the human asked for.
export type CodingTeamKind = 'plan' | 'qa-fix' | 'follow-up';

export interface CodingTeamState {
  // "assigned" = the lead has split the work and the team hasn't started
  // (the Coding tab starts it once the lead's turn ends). "interrupted" =
  // the server stopped mid-run (set at boot); the run endpoint resumes
  // every member that hasn't merged yet.
  status: 'assigned' | 'running' | 'done' | 'needs_attention' | 'interrupted';
  // 1 for the session's first team; each later split is the next round.
  round: number;
  kind: CodingTeamKind;
  members: CodingTeamMember[];
  startedAt: string;
  finishedAt: string | null;
}

export type ReferenceDocsStage = 'requirements' | 'plan' | 'coding' | 'qa';

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
  // Set when the coding lead split the work into 2+ workstreams — the
  // members' own transcripts live here, not in transcripts.coding (which is
  // the lead's own chat: the split, follow-ups after merge, QA fixes).
  codingTeam: CodingTeamState | null;
  // Earlier rounds, oldest first, kept for their logs when the lead splits
  // work again (e.g. QA fixes after the plan's team).
  codingTeamHistory: CodingTeamState[];
  // The single coding agent's current conversation: the plan step it was
  // started for, the transcript entry it started after (null = the start),
  // and its size after its last turn. coding-agent.ts starts a fresh
  // conversation, opened with a handoff (agents/handoff.ts), when the next
  // automatic step turn is for a different step, for a QA fix, or when this
  // one got large — instead of re-sending every earlier step on each call.
  codingContext: CodingContext | null;

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

  // Which set of reference documents (sessions/reference-docs.ts) each stage
  // has been told about, so the list is only re-sent when it changes.
  referenceDocsSeen: Partial<Record<ReferenceDocsStage, string>>;

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
