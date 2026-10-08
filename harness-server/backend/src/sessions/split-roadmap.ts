import type { SessionRecord, SessionStage } from './session.js';

// Where each part of a split feature stands, derived from the parent's
// proposal and its child sessions (never stored, so it can't drift from
// them). Shared by GET /api/sessions/:id/roadmap, a part's kickoff brief and
// the plan-approval dependency check.

export type RoadmapPartStatus =
  // Session exists but nobody has talked to its requirements agent yet.
  | 'not-started'
  | 'in-progress'
  // QA reviewed (stage 'done') — the work is delivered.
  | 'shipped'
  // Rejected; the human can reopen it.
  | 'dropped'
  // The child session was deleted.
  | 'missing';

export interface RoadmapPart {
  index: number;
  sessionId: string;
  title: string;
  sessionKey: string;
  // What works once this part ships (propose_split's `outcome`; absent on
  // proposals made before it existed).
  outcome: string | null;
  stage: SessionStage | null;
  status: RoadmapPartStatus;
  dependsOn: number[];
  // Parts this one depends on that haven't shipped yet.
  blockedBy: number[];
  branch: string | null;
  delivery: SessionRecord['delivery'];
}

export interface SplitRoadmap {
  parent: { sessionId: string; sessionKey: string; title: string; rationale: string | null };
  parts: RoadmapPart[];
  shipped: number;
  // The part to work on next: the earliest part in build order that isn't
  // shipped and whose dependencies all are. Null when everything shipped or
  // every remaining part is waiting on something.
  nextIndex: number | null;
}

export function partStatus(child: SessionRecord | undefined): RoadmapPartStatus {
  if (!child) return 'missing';
  if (child.stage === 'done') return 'shipped';
  if (child.stage === 'abandoned') return 'dropped';
  if (child.stage === 'requirements-in-progress' && child.transcripts.requirements.length === 0 && !child.requirementsPath) {
    return 'not-started';
  }
  return 'in-progress';
}

/**
 * `children` may hold any sessions; only the parent's splitInto ids are
 * read. Dependencies come from the parent's proposal (same indexes as
 * splitInto), falling back to each child's own splitFrom.dependsOnSessionIds.
 */
export function buildSplitRoadmap(parent: SessionRecord, children: Iterable<SessionRecord>): SplitRoadmap {
  const byId = new Map<string, SessionRecord>();
  for (const s of children) byId.set(s.id, s);
  const proposalParts = parent.splitProposal?.parts.length === parent.splitInto.length ? parent.splitProposal.parts : null;

  const parts: RoadmapPart[] = parent.splitInto.map((id, index) => {
    const child = byId.get(id);
    const proposed = proposalParts?.[index];
    const dependsOn =
      proposed?.dependsOn ??
      (child?.splitFrom?.dependsOnSessionIds ?? []).map((d) => parent.splitInto.indexOf(d)).filter((i) => i >= 0 && i < index);
    return {
      index,
      sessionId: id,
      title: child?.title ?? proposed?.title ?? `Part ${index + 1}`,
      sessionKey: child?.sessionKey ?? proposed?.sessionKey ?? '',
      outcome: proposed?.outcome?.trim() || null,
      stage: child?.stage ?? null,
      status: partStatus(child),
      dependsOn,
      blockedBy: [],
      branch: child?.branch ?? null,
      delivery: child?.delivery ?? null,
    };
  });
  for (const part of parts) part.blockedBy = part.dependsOn.filter((d) => parts[d]?.status !== 'shipped');

  const next = parts.find(
    (p) => (p.status === 'in-progress' || p.status === 'not-started') && p.blockedBy.length === 0
  );
  return {
    parent: {
      sessionId: parent.id,
      sessionKey: parent.sessionKey,
      title: parent.title,
      rationale: parent.splitProposal?.rationale ?? null,
    },
    parts,
    shipped: parts.filter((p) => p.status === 'shipped').length,
    nextIndex: next?.index ?? null,
  };
}

export function deliverySummary(part: RoadmapPart): string {
  if (!part.delivery) return part.branch ? `branch ${part.branch}` : 'no branch';
  if (part.delivery.kind === 'merged') return `merged into ${part.delivery.target}`;
  return `${part.delivery.kind === 'merge_request' ? 'merge request' : 'pushed'} into ${part.delivery.target}${
    part.delivery.url ? ` (${part.delivery.url})` : ''
  } — may not be merged yet`;
}

const STATUS_TEXT: Record<RoadmapPartStatus, string> = {
  'not-started': 'not started',
  'in-progress': 'in progress',
  shipped: 'shipped',
  dropped: 'dropped',
  missing: 'deleted',
};

const MAX_CRITERIA_CHARS = 1500;

/** The "## Acceptance criteria" section of a requirements doc, capped — what a shipped part delivered. */
export function acceptanceCriteria(markdown: string): string | null {
  const match = /^##\s+acceptance criteria\s*$/im.exec(markdown);
  if (!match) return null;
  const rest = markdown.slice(match.index + match[0].length);
  const end = rest.search(/^##\s/m);
  const body = (end >= 0 ? rest.slice(0, end) : rest).trim();
  if (!body) return null;
  return body.length > MAX_CRITERIA_CHARS ? `${body.slice(0, MAX_CRITERIA_CHARS).trimEnd()}\n…` : body;
}

/**
 * Where the split stands right now, for one part's requirements agent: the
 * parts are built over weeks, so the brief written at split time can't say
 * what has shipped since. `criteriaFor` returns a shipped part's
 * acceptance criteria (or null).
 */
export function roadmapProgressBrief(
  roadmap: SplitRoadmap,
  forIndex: number,
  criteriaFor: (part: RoadmapPart) => string | null
): string {
  const self = roadmap.parts[forIndex];
  const lines = roadmap.parts.map((p) => {
    const here = p.index === forIndex ? ' ← this session' : '';
    const status = p.status === 'shipped' ? `shipped, ${deliverySummary(p)}` : STATUS_TEXT[p.status];
    return `${p.index + 1}. **${p.title}** (${p.sessionKey}) — ${status}${here}`;
  });

  const shipped = roadmap.parts.filter((p) => p.status === 'shipped' && p.index !== forIndex);
  const delivered = shipped.map((p) => {
    const criteria = criteriaFor(p);
    return `### ${p.title} (${p.sessionKey})\n${p.outcome ? `${p.outcome}\n\n` : ''}${criteria ?? '(no acceptance criteria on record)'}`;
  });

  const waiting = self?.blockedBy.map((d) => roadmap.parts[d]) ?? [];
  return [
    `# Progress on "${roadmap.parent.title}" (${roadmap.parent.sessionKey})`,
    `${roadmap.shipped} of ${roadmap.parts.length} parts shipped so far, in build order:`,
    lines.join('\n'),
    delivered.length
      ? `## Already built\n\nThis is in place — build on it rather than re-specifying it.\n\n${delivered.join('\n\n')}`
      : null,
    waiting.length
      ? `## Not built yet\n\nThis part builds on ${waiting.map((p) => `"${p.title}"`).join(', ')}, which ${
          waiting.length > 1 ? "haven't" : "hasn't"
        } shipped. Write the requirements against what that part is planned to deliver, and call out in Open questions anything that depends on how it turns out.`
      : null,
  ]
    .filter(Boolean)
    .join('\n\n');
}
