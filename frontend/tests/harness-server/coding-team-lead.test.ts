import { describe, expect, test } from 'bun:test';

import {
  dropProblem,
  fallbackReport,
  FALLBACK_REPORT_CHARS,
  leadReviewMessage,
  leadWrapUpMessage,
  MAX_SEND_BACKS,
  mergeProblem,
  roundOutcome,
  sendBackProblem,
  startable,
  stuckDependencies,
  workstreamHandover,
} from '../../../harness-server/backend/src/agents/team/lead-core';
import type { TeamMemberStatus } from '../../../harness-server/backend/src/sessions/session';

const m = (id: string, status: TeamMemberStatus, dependsOn: string[] = [], extra: Record<string, unknown> = {}) => ({
  id,
  title: `${id} work`,
  status,
  dependsOn,
  stepIds: [`${id}-step`],
  note: null as string | null,
  branch: `feat--${id}`,
  ...extra,
});

// The lead merges every branch himself, so a workstream starts only once
// what it depends on is merged — a finished-but-unreviewed branch isn't enough.
describe('startable', () => {
  test('starts independent workstreams at once', () => {
    expect(startable([m('api', 'waiting'), m('ui', 'waiting')]).map((x) => x.id)).toEqual(['api', 'ui']);
  });

  test('waits for the lead to merge a dependency, not just for it to finish', () => {
    expect(startable([m('base', 'ready'), m('ui', 'waiting', ['base'])])).toEqual([]);
    expect(startable([m('base', 'merged'), m('ui', 'waiting', ['base'])]).map((x) => x.id)).toEqual(['ui']);
  });

  test('never restarts a member that is running, ready or settled', () => {
    expect(startable([m('a', 'running'), m('b', 'ready'), m('c', 'failed'), m('d', 'dropped')])).toEqual([]);
  });
});

describe('stuckDependencies', () => {
  test('names dependencies that will not merge without a decision', () => {
    const team = [m('a', 'failed'), m('b', 'dropped'), m('c', 'ready'), m('d', 'waiting', ['a', 'b', 'c'])];
    expect(stuckDependencies(team, team[3])).toEqual(['a', 'b']);
  });
});

describe('roundOutcome', () => {
  test('done once everything is merged or taken back', () => {
    expect(roundOutcome([m('a', 'merged'), m('b', 'dropped')])).toBe('done');
  });

  test('a branch the lead never merged needs attention', () => {
    expect(roundOutcome([m('a', 'merged'), m('b', 'ready')])).toBe('needs_attention');
    expect(roundOutcome([m('a', 'merged'), m('b', 'blocked')])).toBe('needs_attention');
  });
});

describe('the lead’s decisions', () => {
  test('merges a ready or failed branch, nothing else', () => {
    expect(mergeProblem(m('a', 'ready'), 'a')).toBeNull();
    expect(mergeProblem(m('a', 'failed'), 'a')).toBeNull();
    expect(mergeProblem(m('a', 'running'), 'a')).toContain('running');
    expect(mergeProblem(m('a', 'merged'), 'a')).toContain('already merged');
    expect(mergeProblem(undefined, 'zz')).toContain('no workstream "zz"');
  });

  test('send-backs are capped', () => {
    expect(sendBackProblem(m('a', 'ready'), 'a')).toBeNull();
    expect(sendBackProblem(m('a', 'waiting'), 'a')).toContain('only a ready or failed');
    expect(sendBackProblem(m('a', 'ready', [], { sendBacks: MAX_SEND_BACKS }), 'a')).toContain(`${MAX_SEND_BACKS} times`);
  });

  test('dropping a workstream takes its dependents with it', () => {
    const team = [m('base', 'failed'), m('ui', 'waiting', ['base']), m('docs', 'waiting', ['ui'])];
    expect(dropProblem(team, ['base'])).toContain('"ui"');
    expect(dropProblem(team, ['base', 'ui'])).toContain('"docs"');
    expect(dropProblem(team, ['base', 'ui', 'docs'])).toBeNull();
  });

  test('cannot drop merged or in-flight work', () => {
    expect(dropProblem([m('a', 'merged')], ['a'])).toContain('already merged');
    expect(dropProblem([m('a', 'running')], ['a'])).toContain('wait for it');
    expect(dropProblem([m('a', 'ready')], [])).toContain('at least one');
  });
});

describe('what the lead is told', () => {
  test('a review turn lists finished and failed branches and who is waiting on a merge', () => {
    const team = [
      m('api', 'ready'),
      m('ui', 'failed', [], { note: "You've hit your session limit" }),
      m('docs', 'waiting', ['api']),
    ];
    const text = leadReviewMessage(team, ['api', 'ui'], 'feat', new Map([['api', 3]]));
    expect(text).toContain('api (api work) finished: 3 commit(s) on feat--api');
    expect(text).toContain("ui (ui work) failed: You've hit your session limit");
    expect(text).toContain('docs starts only once you merge');
    expect(text).toContain('merge_workstream');
    expect(text).not.toMatch(/\n\n\n/);
  });

  test("a finished branch comes with the engineer's report and changed exports", () => {
    const report = {
      summary: 'Adds the job store.',
      steps: [{ id: 'api-step', done: 'jobs/job-store.ts: put/get/list' }],
      interfaces: ['jobs/job-store.ts — putJob(job: Job): Promise<void>: saves a job'],
      checks: 'lint ok, 42 tests pass',
      forLead: ['routes/jobs.ts needs the new import after merge'],
    };
    const team = [m('api', 'ready', [], { report, changedExports: ['jobs/job-store.ts:12  export async function putJob(job: Job)'] })];
    const text = leadReviewMessage(team, ['api'], 'feat', new Map([['api', 2]]));
    expect(text).toContain('  Summary: Adds the job store.');
    expect(text).toContain('  - api-step: jobs/job-store.ts: put/get/list');
    expect(text).toContain('putJob(job: Job): Promise<void>');
    expect(text).toContain('jobs/job-store.ts:12  export async function putJob');
    expect(text).toContain('routes/jobs.ts needs the new import');
    // Before the merge his checkout doesn't have the branch's changes.
    expect(text).toContain("doesn't have a workstream's changes until you merge it");
  });

  test('a dependent gets the summary and interfaces, not the steps, checks or notes for the lead', () => {
    const report = { summary: 'S', steps: [{ id: 'x', done: 'did x' }], interfaces: ['a.ts — f(): g'], checks: 'ok', forLead: ['look'] };
    const text = workstreamHandover(m('api', 'merged', [], { report }), { forDependent: true });
    expect(text).toContain('Summary: S');
    expect(text).toContain('- a.ts — f(): g');
    expect(text).not.toContain('did x');
    expect(text).not.toContain('Checks');
    expect(text).not.toContain('look');
  });

  test('an engineer that filed no report hands over its last message, cut short', () => {
    expect(fallbackReport('  ')).toBeNull();
    const long = fallbackReport('x'.repeat(FALLBACK_REPORT_CHARS + 50))!;
    expect(long.fallback).toBe(true);
    expect(long.summary.length).toBe(FALLBACK_REPORT_CHARS + 1);
    expect(workstreamHandover(m('api', 'ready', [], { report: fallbackReport('Built it.') }))).toContain(
      'Its last message (it filed no report): Built it.',
    );
  });

  test('the wrap-up hands dropped steps back to the lead', () => {
    const text = leadWrapUpMessage([m('api', 'merged'), m('ui', 'dropped')], 'feat');
    expect(text).toContain('You took back ui-step');
    expect(text).toContain('run lint and the unit tests');
  });
});
