import matter from 'gray-matter';

// The path read_doc serves the session's approved plan under (see
// tool-defs/docs-search-tool.ts). It lives in this project's artifacts/,
// outside the target repo, so read_file can't reach it.
export const SESSION_PLAN_DOC = 'session/plan.md';
export const SESSION_REQUIREMENTS_DOC = 'session/requirements.md';

interface PlanStepRef {
  id: string;
  title: string;
}

const normalize = (s: string) =>
  s
    .replace(/^\s*\d+[.)]\s*/, '')
    .replace(/[`'"*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

/**
 * The approved plan as a coding conversation needs it: everything outside
 * the step-by-step section (approach, reuse audit, team), the steps in
 * `focusStepIds` in full, and every other step as one line with where to
 * read it. The whole plan rode along in every request of every coding
 * conversation, and was the largest single part of its starting context,
 * while a conversation only ever works on one step (or one workstream).
 * The frontmatter is dropped: its step list is what the checklist shows.
 *
 * Falls back to the whole plan body when its steps section can't be
 * matched to the frontmatter's steps.
 */
export function planExcerpt(planRaw: string, planSteps: PlanStepRef[], focusStepIds: string[]): string {
  const body = matter(planRaw).content.trim();
  const lines = body.split('\n');

  const h1 = lines.find((l) => /^#\s+/.test(l))?.replace(/^#\s+/, '').trim();
  const stepsStart = lines.findIndex((l) => /^##\s+(\S+\s+)?steps\b/i.test(l));
  if (stepsStart < 0) return body;
  let stepsEnd = lines.findIndex((l, i) => i > stepsStart && /^##\s+/.test(l));
  if (stepsEnd < 0) stepsEnd = lines.length;

  // The `### ` subsections of the steps section, each matched to a step.
  const sections: { heading: string; start: number; end: number }[] = [];
  for (let i = stepsStart + 1; i < stepsEnd; i++) {
    if (/^###\s+/.test(lines[i])) {
      if (sections.length > 0) sections[sections.length - 1].end = i;
      sections.push({ heading: lines[i].replace(/^###\s+/, '').trim(), start: i, end: stepsEnd });
    }
  }
  if (sections.length === 0) return body;

  const byTitle = new Map(sections.map((s) => [normalize(s.heading), s]));
  const sameCount = sections.length === planSteps.length;
  const matched = planSteps.map((step, i) => ({
    step,
    section: byTitle.get(normalize(step.title)) ?? (sameCount ? sections[i] : undefined),
  }));
  if (matched.some((m) => !m.section)) return body;

  const stepsHeading = lines[stepsStart].replace(/^##\s+/, '').trim();
  const headingPrefix = [h1, stepsHeading].filter(Boolean).join(' > ');
  const focus = new Set(focusStepIds);
  const stepParts = matched.map(({ step, section }) =>
    focus.has(step.id)
      ? `\n${lines.slice(section!.start, section!.end).join('\n').trim()}\n`
      : `- ${section!.heading} (id: "${step.id}")`
  );
  const note =
    `${focus.size > 0 ? 'Steps other than yours are' : 'The steps are'} listed by title only. Read one in full ` +
    `with read_doc({ path: "${SESSION_PLAN_DOC}", heading: "${headingPrefix} > <step heading>" }), or the whole ` +
    `plan with just the path.`;

  return [
    lines.slice(0, stepsStart).join('\n').trimEnd(),
    lines[stepsStart],
    note,
    stepParts.join('\n').trim(),
    lines.slice(stepsEnd).join('\n').trim(),
  ]
    .filter(Boolean)
    .join('\n\n');
}
