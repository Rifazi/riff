import type { VisualReview, VisualReviewFinding } from '../sessions/session.js';

// Reviews in a row that send the branch back to the coder before the human gets it anyway.
export const MAX_AGENT_ROUNDS = 2;

const UI_FILE = /\.(tsx|jsx|vue|svelte|astro|css|scss|sass|less|html)$/i;
const NOT_UI = /(^|\/)(__tests__|tests?|e2e|stories)\/|\.(test|spec|stories)\.[a-z]+$|\.d\.ts$/i;

/** The changed files that can alter what a screen looks like. */
export function uiFiles(files: string[]): string[] {
  return files.filter((f) => !NOT_UI.test(f) && (UI_FILE.test(f) || /(^|\/)theme\/theme\.json$/.test(f)));
}

/** A "needs-changes" verdict with no blocker is only minor notes, which never hold a branch. */
export function effectiveVerdict(verdict: 'good' | 'needs-changes', findings: VisualReviewFinding[]): 'good' | 'needs-changes' {
  return verdict === 'needs-changes' && findings.some((f) => f.severity === 'blocker') ? 'needs-changes' : 'good';
}

/** The message that sends the coding lead back to fix what the review (and the human, if they wrote a note) found. */
export function visualFixMessage(review: Pick<VisualReview, 'summary' | 'findings' | 'humanNote'>, by: 'agent' | 'human'): string {
  const list = review.findings.map((f, i) => `${i + 1}. [${f.severity}] ${f.text}`).join('\n');
  const lead =
    by === 'human'
      ? 'The human looked at the screenshots of your branch and wants changes before QA starts.'
      : 'The UI/UX agent looked at screenshots of your branch and it is not ready for QA: the screens need changes.';
  return [
    lead,
    review.humanNote ? `\nThe human wrote:\n${review.humanNote}` : '',
    review.summary ? `\nSummary: ${review.summary}` : '',
    list ? `\nFindings:\n${list}` : '',
    '\nFix these, commit, and finish your steps again. Only change what the findings name.',
  ].join('\n');
}

/** What the next round's agent is told about the last one, so it checks the fixes instead of starting from nothing. */
export function previousReviewNote(prev: VisualReview | null | undefined): string {
  if (!prev || prev.status !== 'changes-requested') return '';
  const list = prev.findings.map((f, i) => `${i + 1}. [${f.severity}] ${f.text}`).join('\n');
  return `\n\n# The last review of this branch\n\nIt was sent back for these. Check whether each is fixed in what you see now, and say so.\n${prev.humanNote ? `\nThe human wrote: ${prev.humanNote}\n` : ''}\n${list}`;
}
