import type { SessionRecord } from './session.js';

// Backend port of frontend/src/lib/stage.ts's stageGroupFor — the
// coordinator route needs to know which stage is currently live without
// going through the browser. Keep these two in sync if the stage machine
// changes; duplicated rather than shared because the two projects don't
// share a package.
export type StageGroup = 'requirements' | 'plan' | 'coding' | 'qa';

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
      if (session.qaReportPath) return 'qa';
      if (session.branch) return 'coding';
      if (session.planPath) return 'plan';
      return 'requirements';
    default:
      return 'requirements';
  }
}
