import { getApp } from '../apps/apps-store.js';
import { appendTranscriptEntry, getSession } from '../sessions/session-store.js';
import { qaRoundsFor } from '../sessions/qa-rounds.js';
import { changedFilesBetween } from '../repo/git.js';
import type { SessionRecord } from '../sessions/session.js';
import { computeFacts, retroChatSummary, ruleLessons, ruleSuggestions, worthReviewing, type LessonDraft, type SystemSuggestion } from './core.js';
import { askModel, retroPrompt } from './model.js';
import { retiredLessonSuggestion } from './core.js';
import { suggestionVerdict, trackSuggestions } from './suggestion-tracker.js';
import {
  addLessons,
  listLessons,
  listTrackedSuggestions,
  saveTrackedSuggestions,
  writeRetrospective,
  type RetrospectiveRecord,
  type StoredSuggestion,
} from './store.js';

const inFlight = new Set<string>();

export const isRetrospectiveRunning = (sessionId: string) => inFlight.has(sessionId);

/** One run per session at a time: a second caller gets the running one's result. */
const running = new Map<string, Promise<RetrospectiveRecord>>();
export function runRetrospectiveOnce(session: SessionRecord): Promise<RetrospectiveRecord> {
  const existing = running.get(session.id);
  if (existing) return existing;
  inFlight.add(session.id);
  const p = runRetrospective(session).finally(() => {
    running.delete(session.id);
    inFlight.delete(session.id);
  });
  running.set(session.id, p);
  return p;
}

async function fixFilesByPass(repoRoot: string, rounds: { pass: number; head: string | null }[]): Promise<Record<number, string[] | null>> {
  const out: Record<number, string[] | null> = {};
  for (let i = 1; i < rounds.length; i++) {
    const from = rounds[i - 1].head;
    const to = rounds[i].head;
    out[rounds[i].pass] = from && to ? await changedFilesBetween(repoRoot, from, to).catch(() => null) : null;
  }
  return out;
}

/**
 * What the session's QA history teaches. Facts and rule-made lessons always;
 * the model adds app-specific lessons and pipeline suggestions only when
 * something failed. Lessons go straight into the briefings of this app's
 * next sessions (themes/theme-context.ts); suggestions for Riff itself are
 * only recorded, for the human to act on.
 */
export async function runRetrospective(session: SessionRecord): Promise<RetrospectiveRecord> {
  const app = await getApp(session.appId);
  const rounds = await qaRoundsFor(session, app.repoRoot);
  const facts = computeFacts({
    rounds,
    fixFilesByPass: await fixFilesByPass(app.repoRoot, rounds),
    gateSendBacks: session.coordinatorGateSendBacks,
  });

  let summary = '';
  let drafts: LessonDraft[] = [];
  let raised: SystemSuggestion[] = [];
  let modelUsed = false;

  if (worthReviewing(facts)) {
    drafts = ruleLessons(facts);
    raised = ruleSuggestions(facts);
    const modelRetro = await askModel(retroPrompt({ title: session.title, facts, rounds, lessons: listLessons(session.appId), tracked: listTrackedSuggestions(session.appId) }));
    if (modelRetro) {
      modelUsed = true;
      summary = modelRetro.summary;
      drafts = [...drafts, ...modelRetro.lessons];
      raised = [...raised, ...modelRetro.suggestions];
    }
  }

  // Score what was in the briefings against how this session went (clean sessions count too), then learn from it.
  const when = { id: session.id, startedAt: session.createdAt };
  const { lessons, added, retired } = addLessons(session.appId, when, drafts);
  raised = [...raised, ...retired.map(retiredLessonSuggestion)];
  const tracking = trackSuggestions(listTrackedSuggestions(session.appId), raised, when, new Date().toISOString());
  saveTrackedSuggestions(session.appId, tracking.tracked);
  const suggestions: StoredSuggestion[] = tracking.visible.map(({ suggestion, tracked }) => ({
    ...suggestion,
    key: tracked.key,
    seenIn: tracked.raisedIn.length,
    status: tracked.status,
    verdict: suggestionVerdict(tracked),
  }));

  const mine = lessons.filter((l) => l.sessionIds.includes(session.id));
  const record: RetrospectiveRecord = {
    sessionId: session.id,
    appId: session.appId,
    title: session.title,
    at: new Date().toISOString(),
    facts,
    summary,
    lessonsAdded: added,
    lessons: mine.map((l) => ({ id: l.id, text: l.text })),
    suggestions,
    modelUsed,
    lessonsRetired: retired.map((l) => ({ id: l.id, text: l.text, reason: l.retiredReason ?? '' })),
    suggestionsMuted: tracking.newlyMuted.map((t) => ({ key: t.key, title: t.title, reason: t.mutedReason ?? '' })),
  };
  writeRetrospective(record);
  return record;
}

/** Runs the retrospective in the background once a session's branch has been delivered. Never throws or blocks the delivery. */
export function scheduleRetrospective(session: SessionRecord): void {
  if (isRetrospectiveRunning(session.id)) return;
  void (async () => {
    try {
      const record = await runRetrospectiveOnce(session);
      if (!worthReviewing(record.facts) && record.lessonsRetired.length === 0) return;
      const latest = (await getSession(session.id)) ?? session;
      await appendTranscriptEntry(latest.id, 'qa', {
        role: 'system',
        text: retroChatSummary(record.facts, record.lessonsAdded, record.suggestions.length, record.lessonsRetired.length, record.suggestionsMuted.length),
      });
    } catch (err) {
      console.warn('[retrospective] failed for', session.id, '—', err instanceof Error ? err.message : err);
    }
  })();
}
