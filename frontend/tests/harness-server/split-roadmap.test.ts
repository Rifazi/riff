import { describe, expect, test } from 'bun:test';

// Build order and progress of a split feature (sessions/split-roadmap.ts):
// which parts have shipped, what each is waiting on, and which comes next.
import {
  acceptanceCriteria,
  buildSplitRoadmap,
  roadmapProgressBrief,
} from '../../../harness-server/backend/src/sessions/split-roadmap';
import type { SessionRecord, SessionStage } from '../../../harness-server/backend/src/sessions/session';

function session(id: string, stage: SessionStage, extra: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id,
    sessionKey: `KEY-${id}`,
    title: `Title ${id}`,
    stage,
    branch: null,
    delivery: null,
    requirementsPath: null,
    splitInto: [],
    splitFrom: null,
    splitProposal: null,
    transcripts: { requirements: stage === 'requirements-in-progress' ? [] : [{}], plan: [], coding: [], qa: [] },
    ...extra,
  } as unknown as SessionRecord;
}

const parent = session('p', 'split', {
  splitInto: ['a', 'b', 'c', 'd'],
  splitProposal: {
    rationale: 'Four features.',
    proposedAt: '2026-10-01T00:00:00Z',
    parts: [
      { title: 'A', sessionKey: 'KEY-a', brief: '', outcome: 'Data model exists', dependsOn: [] },
      { title: 'B', sessionKey: 'KEY-b', brief: '', outcome: 'Users can export', dependsOn: [0] },
      { title: 'C', sessionKey: 'KEY-c', brief: '', dependsOn: [] },
      { title: 'D', sessionKey: 'KEY-d', brief: '', dependsOn: [0, 1] },
    ],
  },
});

describe('buildSplitRoadmap', () => {
  test('nothing started: the first part is next and dependents are blocked', () => {
    const roadmap = buildSplitRoadmap(parent, [
      parent,
      session('a', 'requirements-in-progress'),
      session('b', 'requirements-in-progress'),
      session('c', 'requirements-in-progress'),
      session('d', 'requirements-in-progress'),
    ]);
    expect(roadmap.parts.map((p) => p.status)).toEqual(['not-started', 'not-started', 'not-started', 'not-started']);
    expect(roadmap.parts.map((p) => p.blockedBy)).toEqual([[], [0], [], [0, 1]]);
    expect(roadmap.nextIndex).toBe(0);
    expect(roadmap.shipped).toBe(0);
    expect(roadmap.parts[1].outcome).toBe('Users can export');
    expect(roadmap.parts[2].outcome).toBeNull();
  });

  test('a shipped foundation unblocks the next part in order', () => {
    const roadmap = buildSplitRoadmap(parent, [
      session('a', 'done', { delivery: { kind: 'merged', target: 'main', url: null, detail: '', at: '' } }),
      session('b', 'requirements-in-progress'),
      session('c', 'coding-in-progress'),
      session('d', 'requirements-in-progress'),
    ]);
    expect(roadmap.parts.map((p) => p.status)).toEqual(['shipped', 'not-started', 'in-progress', 'not-started']);
    expect(roadmap.parts[1].blockedBy).toEqual([]);
    expect(roadmap.parts[3].blockedBy).toEqual([1]);
    expect(roadmap.nextIndex).toBe(1);
    expect(roadmap.shipped).toBe(1);
  });

  test('dropped and deleted parts block their dependents; everything shipped means no next part', () => {
    const blocked = buildSplitRoadmap(parent, [session('a', 'abandoned'), session('c', 'done')]);
    expect(blocked.parts.map((p) => p.status)).toEqual(['dropped', 'missing', 'shipped', 'missing']);
    expect(blocked.nextIndex).toBeNull();

    const finished = buildSplitRoadmap(parent, ['a', 'b', 'c', 'd'].map((id) => session(id, 'done')));
    expect(finished.shipped).toBe(4);
    expect(finished.nextIndex).toBeNull();
  });

  test('without a matching proposal, dependencies come from the children', () => {
    const legacy = session('p', 'split', { splitInto: ['a', 'b'], splitProposal: null });
    const roadmap = buildSplitRoadmap(legacy, [
      session('a', 'plan-in-progress'),
      session('b', 'requirements-in-progress', {
        splitFrom: { sessionId: 'p', sessionKey: 'KEY-p', title: 'P', dependsOnSessionIds: ['a'] },
      }),
    ]);
    expect(roadmap.parts[1].dependsOn).toEqual([0]);
    expect(roadmap.parts[1].blockedBy).toEqual([0]);
    expect(roadmap.parts[1].title).toBe('Title b');
    expect(roadmap.nextIndex).toBe(0);
  });
});

describe('roadmapProgressBrief', () => {
  test('tells a part what shipped and what it is still waiting on', () => {
    const roadmap = buildSplitRoadmap(parent, [
      session('a', 'done', { delivery: { kind: 'merge_request', target: 'main', url: 'https://x/mr/1', detail: '', at: '' } }),
      session('b', 'coding-in-progress'),
      session('c', 'requirements-in-progress'),
      session('d', 'requirements-in-progress'),
    ]);
    const brief = roadmapProgressBrief(roadmap, 3, (p) => (p.index === 0 ? '- [x] Table exists' : null));
    expect(brief).toContain('1 of 4 parts shipped');
    expect(brief).toContain('**Title d** (KEY-d) — not started ← this session');
    expect(brief).toContain('shipped, merge request into main (https://x/mr/1) — may not be merged yet');
    expect(brief).toContain('### Title a (KEY-a)\nData model exists\n\n- [x] Table exists');
    expect(brief).toContain(`builds on "Title b", which hasn't shipped`);
  });
});

describe('acceptanceCriteria', () => {
  test('returns only that section', () => {
    const doc = '# T\n\n## Problem statement\nx\n\n## Acceptance criteria\n- [ ] one\n- [ ] two\n\n## Non-goals\ny\n';
    expect(acceptanceCriteria(doc)).toBe('- [ ] one\n- [ ] two');
    expect(acceptanceCriteria('# T\n\n## Problem statement\nx')).toBeNull();
  });
});
