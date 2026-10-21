/**
 * Whether Bridget's suggestions for the pipeline are worth making. Each one
 * is remembered per app with the sessions that raised it. One raised again
 * and again with nobody acting on it is muted; one the human marks done is
 * watched, and if it keeps coming back afterwards, it didn't help. Pure.
 */
import { findingSimilarity, SAME_FINDING } from '../sessions/qa-loop.js';
import type { SystemSuggestion } from './core.js';

export type SuggestionStatus = 'open' | 'done' | 'dismissed' | 'muted';

export interface TrackedSuggestion {
  key: string;
  title: string;
  detail: string;
  status: SuggestionStatus;
  raisedIn: string[];
  firstAt: string;
  lastAt: string;
  doneAt?: string;
  /** Sessions that started after it was marked done, and the ones among them that raised it again. */
  sinceDone: string[];
  recurredSinceDone: string[];
  mutedReason?: string;
}

/** Raised this many times with no action, and Bridget stops raising it. */
export const MUTE_AFTER = 4;
export const MIN_SINCE_DONE = 3;

export type SuggestionVerdict = 'open' | 'unproven' | 'effective' | 'not-effective';

export function suggestionVerdict(t: TrackedSuggestion): SuggestionVerdict {
  if (t.status !== 'done') return 'open';
  if (t.sinceDone.length < MIN_SINCE_DONE) return 'unproven';
  return t.recurredSinceDone.length / t.sinceDone.length >= 0.5 ? 'not-effective' : 'effective';
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
export const suggestionKey = (s: SystemSuggestion) => s.code ?? `m:${norm(s.title).slice(0, 60)}`;

function find(tracked: TrackedSuggestion[], s: SystemSuggestion): TrackedSuggestion | undefined {
  const key = suggestionKey(s);
  return (
    tracked.find((t) => t.key === key) ??
    (s.code === null ? tracked.find((t) => t.key.startsWith('m:') && findingSimilarity(`${t.title} ${t.detail}`, `${s.title} ${s.detail}`) >= SAME_FINDING) : undefined)
  );
}

export interface TrackResult {
  tracked: TrackedSuggestion[];
  /** What to show for this session: raised now and not muted or dismissed, each with its history. */
  visible: { suggestion: SystemSuggestion; tracked: TrackedSuggestion }[];
  /** Muted by this session's sighting. */
  newlyMuted: TrackedSuggestion[];
}

export function trackSuggestions(
  existing: TrackedSuggestion[],
  raised: SystemSuggestion[],
  session: { id: string; startedAt: string },
  now: string,
): TrackResult {
  const tracked = existing.map((t) => ({ ...t, raisedIn: [...t.raisedIn], sinceDone: [...t.sinceDone], recurredSinceDone: [...t.recurredSinceDone] }));
  const visible: TrackResult['visible'] = [];
  const newlyMuted: TrackedSuggestion[] = [];
  const touched = new Set<TrackedSuggestion>();

  for (const s of raised) {
    let t = find(tracked, s);
    if (!t) {
      t = { key: suggestionKey(s), title: s.title, detail: s.detail, status: 'open', raisedIn: [], firstAt: now, lastAt: now, sinceDone: [], recurredSinceDone: [] };
      tracked.push(t);
    }
    touched.add(t);
    if (!t.raisedIn.includes(session.id)) t.raisedIn.push(session.id);
    t.lastAt = now;
    if (t.status === 'done' && t.doneAt && session.startedAt > t.doneAt) {
      if (!t.sinceDone.includes(session.id)) t.sinceDone.push(session.id);
      if (!t.recurredSinceDone.includes(session.id)) t.recurredSinceDone.push(session.id);
    }
    if (t.status === 'open' && t.raisedIn.length >= MUTE_AFTER) {
      t.status = 'muted';
      t.mutedReason = `raised in ${t.raisedIn.length} sessions and nobody acted on it`;
      newlyMuted.push(t);
      continue;
    }
    if (t.status === 'open' || t.status === 'done') visible.push({ suggestion: s, tracked: t });
  }

  // A session that didn't raise a done suggestion is evidence it helped.
  for (const t of tracked) {
    if (touched.has(t) || t.status !== 'done' || !t.doneAt || session.startedAt <= t.doneAt) continue;
    if (!t.sinceDone.includes(session.id)) t.sinceDone.push(session.id);
  }
  return { tracked, visible, newlyMuted };
}

export function setSuggestionStatus(tracked: TrackedSuggestion[], key: string, status: SuggestionStatus, now: string): TrackedSuggestion[] {
  return tracked.map((t) => {
    if (t.key !== key) return t;
    const next: TrackedSuggestion = { ...t, status };
    if (status === 'done') {
      next.doneAt = now;
      next.sinceDone = [];
      next.recurredSinceDone = [];
    }
    if (status === 'open') {
      next.raisedIn = [];
      delete next.mutedReason;
    }
    return next;
  });
}
