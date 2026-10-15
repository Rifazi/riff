import type { CodingTeamMember, MergeFailure, TeamMemberStatus, WorkstreamReport } from '../../sessions/session.js';

// Pure rules for a coding team whose lead (Jack) reviews and merges every
// workstream's branch himself: when a member can start, what the lead is
// told, which of his decisions are allowed, and how a round ends. Used by
// coding-team.ts (the runner) and tool-defs/team-lead-tools.ts (his tools);
// tested from frontend/tests/harness-server/coding-team-lead.test.ts.

type Member = Pick<CodingTeamMember, 'id' | 'title' | 'status' | 'dependsOn' | 'stepIds' | 'note' | 'branch'> &
  Partial<Pick<CodingTeamMember, 'sendBacks' | 'feedback' | 'report' | 'changedExports'>>;

// How much of an engineer's last message stands in for a report it never filed.
export const FALLBACK_REPORT_CHARS = 1_200;

// Before a merge the lead's checkout is the session branch, which doesn't
// have the workstream's changes: read_file there shows the old code.
export const STALE_CHECKOUT_NOTE =
  "Your checkout is the session branch: it doesn't have a workstream's changes until you merge it, so read_file " +
  "shows the old code. Review from the engineer's report and review_workstream's diff (pass path for one file's " +
  'whole diff), and run lint and tests after merging.';

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

/**
 * A workstream's merge commit message. The title goes in the body: a
 * commit-msg hook (commitlint's 100-char header) refused a subject that
 * carried it.
 */
export function mergeCommitMessage(member: Pick<Member, 'id' | 'title'>): string {
  const subject = `merge ${member.id} workstream`;
  return `chore: ${subject.length > 72 ? `${subject.slice(0, 71)}…` : subject}\n\n${member.title}`;
}

/**
 * Why the same merge shouldn't be run again, or null: it failed on these
 * same two commits already, so it would fail the same way. The lead ran one
 * refused merge 20 times in a round, three times within 20 seconds and
 * again after every context reset.
 */
export function mergeRetryProblem(
  failure: MergeFailure | null | undefined,
  heads: { head: string | null; into: string | null },
  now = Date.now(),
): string | null {
  if (!failure || failure.head !== heads.head || failure.into !== heads.into) return null;
  const minutes = Math.max(1, Math.round((now - Date.parse(failure.at)) / 60_000));
  return (
    `merging it failed ${minutes} min ago and neither its branch nor the session branch has changed since, so it ` +
    `would fail the same way: ${failure.reason}. Don't retry as is — send it back with what to fix, change the ` +
    'session branch, or drop it.'
  );
}

/** The line of a failed merge's output that says why: a hook's ✖ lines, else the first line. */
export function mergeFailureReason(error: string): string {
  const lines = error.split('\n').map((l) => l.trim()).filter(Boolean);
  const marked = lines.filter((l) => /^(✖|error\b|fatal\b|CONFLICT\b)/i.test(l));
  return (marked.length ? marked.slice(0, 3).join('; ') : (lines[0] ?? error)).slice(0, 300);
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

// A checks line that doesn't plainly say lint and the tests passed.
const WORRYING_CHECKS = /\b(fail|error|skip|couldn'?t|could not|cannot|can'?t|not run|unable|broken|flaky|todo|pending)/i;

/**
 * Why a finished workstream needs the lead's review instead of being merged
 * straight away, or null when it can merge unreviewed: it finished every
 * step through finish_step (so lint and the tests passed on its branch),
 * filed a report that flags nothing and says the checks passed, was never
 * sent back, and left nothing uncommitted. Jack's per-branch reviews were
 * most of his turns (one ran 80 requests re-reviewing a branch), and his
 * wrap-up still checks the merged whole.
 */
export function autoMergeProblem(member: Member, stepStatus: Map<string, string>, leftUncommitted: boolean): string | null {
  if (member.status !== 'ready') return `it is ${member.status}`;
  const r = member.report;
  if (!r || r.fallback) return 'it filed no report';
  if (member.sendBacks) return 'it was sent back, so the lead checks his feedback was done';
  if (r.forLead.length) return 'its report flags something for the lead';
  if (!r.checks.trim() || WORRYING_CHECKS.test(r.checks)) return "its report doesn't say lint and the tests passed";
  const open = member.stepIds.filter((id) => stepStatus.get(id) !== 'done');
  if (open.length) return `${open.join(', ')} ${open.length === 1 ? "wasn't" : "weren't"} finished with passing checks`;
  if (leftUncommitted) return 'it left uncommitted changes that were committed for it';
  return null;
}

/** The lead's note on workstreams merged without his review. */
export function autoMergedNote(members: Member[], ids: string[]): string {
  const merged = members.filter((m) => ids.includes(m.id));
  if (!merged.length) return '';
  const lines = merged.map((m) => {
    const handover = workstreamHandover(m, { forDependent: true });
    return `- ${m.id} (${m.title})${handover ? `\n${indent(handover)}` : ''}`;
  });
  return (
    'Merged without your review, since each finished every step with lint and the tests passing, reported nothing ' +
    'for you and merged cleanly:\n' +
    lines.join('\n')
  );
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

/** A report built from an engineer's last message, for one that never called report_workstream. */
export function fallbackReport(lastText: string | null | undefined): WorkstreamReport | null {
  const text = (lastText ?? '').trim();
  if (!text) return null;
  const summary = text.length > FALLBACK_REPORT_CHARS ? `${text.slice(0, FALLBACK_REPORT_CHARS)}…` : text;
  return { summary, steps: [], interfaces: [], checks: '', forLead: [], fallback: true };
}

/**
 * What a workstream hands on: its report and the exports its branch changed.
 * `forDependent` leaves out what only the lead needs (steps, checks, notes).
 */
export function workstreamHandover(member: Member, options: { forDependent?: boolean } = {}): string {
  const r = member.report;
  const lines: string[] = [];
  if (r) {
    lines.push(r.fallback ? `Its last message (it filed no report): ${r.summary}` : `Summary: ${r.summary}`);
    if (!options.forDependent) {
      for (const step of r.steps) lines.push(`- ${step.id}: ${step.done}`);
    }
    if (r.interfaces.length) lines.push('Interfaces:', ...r.interfaces.map((i) => `- ${i}`));
    if (!options.forDependent) {
      if (r.checks) lines.push(`Checks: ${r.checks}`);
      if (r.forLead.length) lines.push('For you:', ...r.forLead.map((n) => `- ${n}`));
    }
  }
  if (member.changedExports?.length) lines.push('Exports it adds or changes:', ...member.changedExports.map((e) => `- ${e}`));
  return lines.join('\n');
}

const indent = (text: string) => text.replace(/^/gm, '  ');

/**
 * The message for the lead's turn when workstreams need his decision: which
 * finished or failed, the whole team's state, and what he can do.
 */
export function leadReviewMessage(members: Member[], ids: string[], sessionBranch: string, commitsAhead: Map<string, number>): string {
  const byId = new Map(members.map((m) => [m.id, m]));
  const news = ids
    .map((id) => byId.get(id))
    .filter((m): m is NonNullable<typeof m> => Boolean(m))
    .map((m) => {
      const head =
        m.status === 'ready'
          ? `- ${m.id} (${m.title}) finished: ${commitsAhead.get(m.id) ?? '?'} commit(s) on ${m.branch}, ready for your review.`
          : `- ${m.id} (${m.title}) failed: ${m.note ?? 'no reason recorded'}.`;
      const handover = workstreamHandover(m);
      return handover ? `${head}\n${indent(handover)}` : head;
    });
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
    STALE_CHECKOUT_NOTE,
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
export function leadWrapUpMessage(members: Member[], sessionBranch: string, autoMerged: string[] = []): string {
  const dropped = members.filter((m) => m.status === 'dropped');
  const unreviewed = autoMergedNote(members, autoMerged);
  return [
    `[Team update] Every workstream is merged into ${sessionBranch} or dropped:`,
    teamStatusLines(members),
    '',
    ...(unreviewed ? [unreviewed, 'Their code is on the branch now: your check of the merged whole covers it.', ''] : []),
    'As the lead, check the merged whole: run lint and the unit tests on the branch and get both passing, ' +
      'including any check an engineer could not run in their own checkout, fix anything the merges broke between ' +
      'workstreams, and keep the checklist accurate with write_coding_plan. Then read the notes for QA ' +
      '(team_status lists them) and drop any that no longer hold with note_for_qa withdraw.' +
      (dropped.length
        ? ` You took back ${dropped.flatMap((m) => m.stepIds).join(', ')}: they're still on the checklist for you to build next, one step at a time.`
        : ''),
    'Then tell the human in a few lines what the team built and anything they should look at.',
  ].join('\n');
}
