import type { SessionRecord } from './types';

export type StageGroup = 'requirements' | 'plan' | 'coding' | 'qa';

export const STAGE_GROUPS: { group: StageGroup; label: string }[] = [
  { group: 'requirements', label: 'Requirements' },
  { group: 'plan', label: 'Plan' },
  { group: 'coding', label: 'Coding' },
  { group: 'qa', label: 'QA' },
];

/**
 * Single source of truth for "which page is this session's stage showing
 * right now" — used both for routing (SessionRedirect) and for the stepper
 * (reached/active state). Keeping this in one place avoids the stepper and
 * the router silently disagreeing about what stage a session is in, which
 * is what made the Coding tab look unreachable right after requirements
 * approval even though the coding page was already live.
 */
export function stageGroupFor(session: SessionRecord): StageGroup {
  switch (session.stage) {
    case 'requirements-in-progress':
      return 'requirements';
    case 'requirements-approved':
    case 'plan-in-progress':
      return 'plan';
    case 'plan-approved':
    case 'coding-in-progress':
    case 'coding-review':
      return 'coding';
    case 'qa-in-progress':
    case 'qa-reviewed':
    case 'done':
      return 'qa';
    case 'abandoned':
      // Rejected mid-flight — land on wherever it actually got to, not
      // always back at the start.
      if (session.qaReportPath) return 'qa';
      if (session.branch) return 'coding';
      if (session.planPath) return 'plan';
      return 'requirements';
    default:
      return 'requirements';
  }
}

const GROUP_ORDER: StageGroup[] = ['requirements', 'plan', 'coding', 'qa'];

// The current stage's group alone under-reports how far a session has
// gotten once it's been sent back to an earlier stage (e.g.
// coding/send-back-to-requirements reverts `stage` to
// 'requirements-in-progress' while the branch/plan/QA artifacts it already
// produced are all still there) — without this, the later tabs would
// render as locked even though their content still exists and is still
// reachable.
function furthestReachedGroupIndex(session: SessionRecord): number {
  let index = GROUP_ORDER.indexOf(stageGroupFor(session));
  if (session.planPath || session.planStatus) index = Math.max(index, GROUP_ORDER.indexOf('plan'));
  if (session.branch) index = Math.max(index, GROUP_ORDER.indexOf('coding'));
  if (session.qaReportPath || session.qaStatus) index = Math.max(index, GROUP_ORDER.indexOf('qa'));
  return index;
}

export function isStageReached(session: SessionRecord, group: StageGroup): boolean {
  return GROUP_ORDER.indexOf(group) <= furthestReachedGroupIndex(session);
}

export function isStageCompleted(session: SessionRecord, group: StageGroup): boolean {
  if (group === 'requirements') return session.requirementsStatus === 'approved';
  if (group === 'plan') return session.planStatus === 'approved';
  if (group === 'coding') return Boolean(session.codingApprovedAt);
  return session.qaStatus === 'reviewed';
}

// "Reached" only means the stage is unlocked/viewable — it says nothing
// about whether the agent has actually been asked to do anything there yet.
// Without this, a freshly-unlocked stage with an empty chat and no output
// yet reads as "In progress", which looks like the agent is working when
// nothing has been triggered.
export function hasStageActivity(session: SessionRecord, group: StageGroup): boolean {
  if (group === 'requirements') return session.transcripts.requirements.length > 0;
  if (group === 'plan') return session.transcripts.plan.length > 0 || Boolean(session.planPath);
  if (group === 'coding') return session.transcripts.coding.length > 0 || Boolean(session.branch);
  return session.transcripts.qa.length > 0 || Boolean(session.qaReportPath);
}

export const SESSIONS_HREF = '/dev-sessions';

// Static export (no dynamic route segments), so the session and stage
// travel as query params.
export function sessionHref(sessionId: string, group?: StageGroup): string {
  return `/dev-sessions/session?id=${encodeURIComponent(sessionId)}${group ? `&stage=${group}` : ''}`;
}

export const STAGE_LABEL: Record<string, string> = {
  'requirements-in-progress': 'Requirements',
  'requirements-approved': 'Requirements approved',
  'plan-in-progress': 'Plan',
  'plan-approved': 'Plan approved',
  'coding-in-progress': 'Coding',
  'coding-review': 'Coding review',
  'qa-in-progress': 'QA',
  'qa-reviewed': 'QA reviewed',
  done: 'Done',
  abandoned: 'Abandoned',
};
