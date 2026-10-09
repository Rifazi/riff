import type { CodingTeamMember, TeamMemberStatus } from '../../sessions/session.js';

// Pure rules for a coding team whose lead (Jack) reviews and merges every
// workstream's branch himself: when a member can start, what the lead is
// told, which of his decisions are allowed, and how a round ends. Used by
// coding-team.ts (the runner) and tool-defs/team-lead-tools.ts (his tools);
// tested from frontend/tests/harness-server/coding-team-lead.test.ts.

type Member = Pick<CodingTeamMember, 'id' | 'title' | 'status' | 'dependsOn' | 'stepIds' | 'note' | 'branch'> &
  Partial<Pick<CodingTeamMember, 'sendBacks' | 'feedback'>>;

// The lead can send one workstream back this many times per round, so a
// review loop can't run forever.
export const MAX_SEND_BACKS = 3;

// Nothing more happens to these without a decision from the lead or human.
const SETTLED: TeamMemberStatus[] = ['merged', 'dropped', 'failed', 'blocked', 'ready'];

export function isSettled(status: TeamMemberStatus): boolean {
  return SETTLED.includes(status);
}

/** Waiting members whose dependencies have all been merged by the lead. */
export function startable<M extends Member>(members: M[]): M[] {
  const byId = new Map(members.map((m) => [m.id, m]));
  return members.filter((m) => m.status === 'waiting' && m.dependsOn.every((d) => byId.get(d)?.status === 'merged'));
}

/** The dependencies of a waiting member that will never merge without a decision (failed, dropped, blocked). */
export function stuckDependencies(members: Member[], member: Member): string[] {
  const byId = new Map(members.map((m) => [m.id, m]));
  return member.dependsOn.filter((d) => {
    const s = byId.get(d)?.status;
    return s === 'failed' || s === 'dropped' || s === 'blocked' || s === undefined;
  });
}

/**
 * A round is done once every workstream is merged, or dropped back to the
 * lead (who builds those steps himself). Anything else needs attention.
 */
export function roundOutcome(members: Member[]): 'done' | 'needs_attention' {
  return members.every((m) => m.status === 'merged' || m.status === 'dropped') ? 'done' : 'needs_attention';
}

/** Why the lead can't merge this member now, or null. */
export function mergeProblem(member: Member | undefined, id: string): string | null {
  if (!member) return `There is no workstream "${id}" in this round.`;
  if (member.status === 'merged') return `"${id}" is already merged.`;
  // A failed run may still have finished its steps (e.g. it ran out of
  // turns while wrapping up): the lead reviews it and decides.
  if (member.status !== 'ready' && member.status !== 'failed') {
    return `"${id}" is ${member.status} — only a finished or failed workstream's branch can be merged.`;
  }
  return null;
}

/** Why the lead can't send this member back now, or null. */
export function sendBackProblem(member: Member | undefined, id: string): string | null {
  if (!member) return `There is no workstream "${id}" in this round.`;
  if (member.status !== 'ready' && member.status !== 'failed') {
    return `"${id}" is ${member.status} — only a ready or failed workstream can be sent back.`;
  }
  if ((member.sendBacks ?? 0) >= MAX_SEND_BACKS) {
    return `"${id}" has been sent back ${MAX_SEND_BACKS} times already. Merge it and fix the rest yourself, or drop it.`;
  }
  return null;
}

/**
 * Why the lead can't drop these members, or null. A dropped workstream's
 * dependents would wait forever, so they must be dropped with it (or be
 * merged already, which can't happen before their dependency merged).
 */
export function dropProblem(members: Member[], ids: string[]): string | null {
  if (ids.length === 0) return 'Name at least one workstream to drop.';
  const byId = new Map(members.map((m) => [m.id, m]));
  for (const id of ids) {
    const m = byId.get(id);
    if (!m) return `There is no workstream "${id}" in this round.`;
    if (m.status === 'merged') return `"${id}" is already merged — its work is on the branch.`;
    if (m.status === 'running' || m.status === 'merging') return `"${id}" is ${m.status} — wait for it to finish first.`;
  }
  const dropping = new Set(ids);
  const orphans = members.filter(
    (m) => !dropping.has(m.id) && m.status !== 'dropped' && m.dependsOn.some((d) => dropping.has(d)),
  );
  if (orphans.length) {
    return `${orphans.map((m) => `"${m.id}"`).join(', ')} depend${orphans.length === 1 ? 's' : ''} on what you're dropping — drop ${orphans.length === 1 ? 'it' : 'them'} too.`;
  }
  return null;
}

/** One line per member, for the lead's prompts and team_status. */
export function teamStatusLines(members: Member[], commitsAhead: Map<string, number> = new Map()): string {
  return members
    .map((m) => {
      const commits = commitsAhead.get(m.id);
      const parts = [
        `${m.id} (${m.title}): ${m.status}`,
        m.branch && m.status !== 'merged' && m.status !== 'dropped' ? `branch ${m.branch}` : null,
        commits !== undefined ? `${commits} commit${commits === 1 ? '' : 's'} ahead` : null,
        `steps ${m.stepIds.join(', ')}`,
        m.dependsOn.length ? `after ${m.dependsOn.join(', ')}` : null,
        m.sendBacks ? `sent back ${m.sendBacks}×` : null,
        m.note ? `— ${m.note}` : null,
      ];
      return `- ${parts.filter(Boolean).join('; ')}`;
    })
    .join('\n');
}

/**
 * The message for the lead's turn when workstreams need his decision: which
 * finished or failed, the whole team's state, and what he can do.
 */
export function leadReviewMessage(members: Member[], ids: string[], sessionBranch: string, commitsAhead: Map<string, number>): string {
  const byId = new Map(members.map((m) => [m.id, m]));
  const news = ids
    .map((id) => byId.get(id))
    .filter((m): m is NonNullable<typeof m> => Boolean(m))
    .map((m) =>
      m.status === 'ready'
        ? `- ${m.id} (${m.title}) finished: ${commitsAhead.get(m.id) ?? '?'} commit(s) on ${m.branch}, ready for your review.`
        : `- ${m.id} (${m.title}) failed: ${m.note ?? 'no reason recorded'}.`,
    );
  const waiting = members.filter((m) => m.status === 'waiting' && m.dependsOn.some((d) => byId.get(d)?.status !== 'merged'));
  return [
    '[Team update] You are the lead: the team builds in parallel, and you decide what lands on ' +
      `${sessionBranch}.`,
    '',
    ...news,
    '',
    'The whole team:',
    teamStatusLines(members, commitsAhead),
    '',
    'For each finished workstream: review_workstream it (commits, diff stat, diff), check it does what its steps ' +
      'ask and fits with what is already merged, then merge_workstream it, or send_back_workstream with exactly ' +
      'what to fix.',
    'For each failed one: review what it committed. Merge it if its steps are actually done, send it back with ' +
      'guidance to finish, drop_workstreams to build its steps yourself after the team, or leave it for the human.',
    waiting.length
      ? `${waiting.map((m) => m.id).join(', ')} start${waiting.length === 1 ? 's' : ''} only once you merge what ${waiting.length === 1 ? 'it depends' : 'they depend'} on, so don't sit on a good branch.`
      : '',
    "Keep this turn to reviewing and merging: the engineers own the steps' code. If merged work needs a small " +
      'integration fix in shared code, make it on the session branch and commit it before you end your turn.',
  ]
    .filter((line, i, all) => line !== '' || all[i - 1] !== '')
    .join('\n')
    .trim();
}

/** The message for the lead's turn after the whole team has merged. */
export function leadWrapUpMessage(members: Member[], sessionBranch: string): string {
  const dropped = members.filter((m) => m.status === 'dropped');
  return [
    `[Team update] Every workstream is merged into ${sessionBranch} or dropped:`,
    teamStatusLines(members),
    '',
    'As the lead, check the merged whole: run lint and the unit tests on the branch, fix anything the merges ' +
      'broke between workstreams, and keep the checklist accurate with write_coding_plan.' +
      (dropped.length
        ? ` You took back ${dropped.flatMap((m) => m.stepIds).join(', ')}: they're still on the checklist for you to build next, one step at a time.`
        : ''),
    'Then tell the human in a few lines what the team built and anything they should look at.',
  ].join('\n');
}
