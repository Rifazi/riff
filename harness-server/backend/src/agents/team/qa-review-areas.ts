import path from 'node:path';
import { z } from 'zod';
import type { QaReviewArea, QaTeamState } from '../../sessions/session.js';

export const reviewAreaSchema = z.object({
  id: z.string().describe('Short stable slug, e.g. "api", "ui", "docs"'),
  title: z.string().describe('What this reviewer checks, e.g. "Report API: totals and filters"'),
  criteria: z
    .array(z.string())
    .min(1)
    .describe('The acceptance criteria this reviewer verifies, worded as in the requirements doc. Each criterion goes to exactly one reviewer.'),
  focusPaths: z
    .array(z.string())
    .describe('Repo-relative files or directories in the diff this reviewer concentrates on, e.g. ["src/api/reports/"]'),
  brief: z
    .string()
    .describe(
      'Anything else this reviewer needs: edge cases to probe, a doc from "Docs to update" to confirm, what a ' +
        'previous QA pass flagged in its area. Reviewers see the requirements doc but not your chat.'
    ),
});

export class InvalidReviewAreasError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidReviewAreasError';
  }
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;

function normalizeFocusPath(p: string): string {
  const trimmed = p.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (!trimmed || path.isAbsolute(trimmed) || trimmed.split('/').includes('..')) {
    throw new InvalidReviewAreasError(`"${p}" isn't a usable focus path — use a repo-relative file or directory.`);
  }
  return trimmed;
}

const criterionKey = (c: string) => c.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Checks the QA lead's split is worth running as a team: at least two
 * reviewers, unique slug ids, and every criterion given to exactly one
 * reviewer — two reviewers judging the same criterion could disagree, and
 * the lead would have to re-check it anyway. Unlike coding workstreams
 * there are no owned paths or dependencies: reviewers only read.
 */
export function validateReviewAreas(areas: QaReviewArea[]): QaReviewArea[] {
  if (areas.length < 2) {
    throw new InvalidReviewAreasError(
      "A QA team needs at least two reviewers — if the review doesn't split, do it yourself instead of calling assign_qa_team."
    );
  }
  const ids = new Set<string>();
  for (const area of areas) {
    if (!SLUG.test(area.id)) throw new InvalidReviewAreasError(`"${area.id}" isn't a usable id — use a short lowercase slug like "api".`);
    if (ids.has(area.id)) throw new InvalidReviewAreasError(`Duplicate reviewer id "${area.id}".`);
    ids.add(area.id);
  }

  const owner = new Map<string, string>();
  const normalized = areas.map((area) => {
    const criteria = area.criteria.map((c) => c.trim()).filter(Boolean);
    if (criteria.length === 0) throw new InvalidReviewAreasError(`Reviewer "${area.id}" has no acceptance criteria to check.`);
    for (const c of criteria) {
      const prev = owner.get(criterionKey(c));
      if (prev) throw new InvalidReviewAreasError(`"${c}" is given to both "${prev}" and "${area.id}" — each criterion belongs to one reviewer.`);
      owner.set(criterionKey(c), area.id);
    }
    return {
      id: area.id,
      title: area.title.trim() || area.id,
      criteria,
      focusPaths: [...new Set(area.focusPaths.map(normalizeFocusPath))],
      brief: area.brief.trim(),
    };
  });
  return normalized;
}

const indent = (text: string) => text.replace(/\n/g, '\n  ');

/**
 * What the QA lead's next turn is handed once its team has finished: the
 * check results, then every reviewer's verdicts and findings. A reviewer
 * that didn't submit has its criteria listed for the lead to check itself.
 */
export function formatQaTeamFindings(team: QaTeamState): string {
  const checks = team.checks
    .map((c) => `- ${c.command}: ${c.status}${c.output && c.status === 'fail' ? `\n  ${indent(c.output.trim())}` : ''}`)
    .join('\n');
  const reviewers = team.members.map((m) => {
    const head = `## ${m.title} (${m.id})`;
    if (!m.findings) {
      return (
        `${head}: no findings submitted${m.note ? ` — ${m.note}` : ''}\n\nIts criteria are unchecked; review them ` +
        `yourself:\n${m.criteria.map((c) => `- ${c}`).join('\n')}`
      );
    }
    const f = m.findings;
    const list = (items: string[]) => (items.length ? items.map((i) => `- ${i}`).join('\n') : '- (none)');
    return (
      `${head}\n\n${f.summary}\n\nCriteria:\n${f.criteria.map((c) => `- [${c.verdict}] ${c.criterion} — ${c.note}`).join('\n')}` +
      `\n\nBlocking:\n${list(f.blockingFindings)}\n\nNotes:\n${list(f.actionableNotes)}`
    );
  });
  return (
    `# Your QA team's findings (round ${team.round})\n\nChecks, run alongside the reviewers:\n${checks}\n\n` +
    `${reviewers.join('\n\n')}\n\n---\n\nYour reviewers have finished. Re-check anything that looks doubtful ` +
    'or is unverified (and any criteria a reviewer left unchecked), re-run a check only if a result above is ' +
    'missing or suspect, then call write_qa_report once, covering every acceptance criterion.'
  );
}
