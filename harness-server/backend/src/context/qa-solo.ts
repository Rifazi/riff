import { numberedCriteria } from './requirements-digest.js';
import matter from 'gray-matter';

export const SOLO_FIRST_REVIEW_MAX_FILES = 8;
export const SOLO_FIRST_REVIEW_MAX_CRITERIA = 5;

/** The acceptance criteria listed in a requirements document. */
export function criteriaCount(requirementsRaw: string): number {
  const body = matter(requirementsRaw).content;
  const start = body.split('\n').findIndex((l) => /^##\s+acceptance/i.test(l.trim()));
  if (start < 0) return 0;
  const rest = body.split('\n').slice(start + 1);
  const end = rest.findIndex((l) => /^##\s/.test(l));
  return numberedCriteria((end < 0 ? rest : rest.slice(0, end)).join('\n')).length;
}

/**
 * A first review small enough for the QA lead alone: a team re-reads the
 * whole branch per reviewer, which only pays when there is a lot to split.
 * Unknown sizes (a diff that couldn't be read, a document with no criteria
 * list) leave the decision to the lead.
 */
export function soloFirstReview(criteria: number, changedFiles: number | null): boolean {
  if (changedFiles === null || criteria === 0) return false;
  return changedFiles <= SOLO_FIRST_REVIEW_MAX_FILES && criteria <= SOLO_FIRST_REVIEW_MAX_CRITERIA;
}
