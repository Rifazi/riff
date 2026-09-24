import type { ModelMessage } from 'ai';

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

// The Meetily meeting a session was started from, when it was created from a
// transcript rather than a typed prompt. The transcript itself lives under
// state/ (gitignored — meeting content is private), not in artifacts/.
export interface SessionMeetingSource {
  meetingId: string;
  meetingTitle: string;
  meetingDate: string | null;
  transcriptPath: string; // harnessRoot-relative
  includesSummary: boolean;
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

  qaReportPath: string | null;
  qaStatus: 'pending-review' | 'reviewed' | null;
  // Set when a QA report is sent back to Coding for fixes instead of being
  // marked reviewed — true until the next coding message is sent, at which
  // point CodingStage has relayed the findings and this clears itself.
  qaFindingsPending: boolean;

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
