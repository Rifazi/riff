import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { mergeLessonsDetailed, scoreLessons, type LessonDraft, type RetroFacts, type StoredLesson, type SystemSuggestion } from './core.js';
import { setSuggestionStatus, type SuggestionStatus, type SuggestionVerdict, type TrackedSuggestion } from './suggestion-tracker.js';

/**
 * What past sessions taught, per app. Lessons are machine-local like the
 * design memory (they name this app's files and habits); retrospectives are
 * state/, disposable with the sessions they describe.
 */
const LESSONS_PATH = process.env.HARNESS_LESSONS_PATH ?? path.join(config.harnessRoot, 'backend', 'local-lessons.json');
const RETRO_DIR = process.env.HARNESS_RETRO_DIR ?? path.join(config.stateDir, 'retrospectives');

type LessonStore = Record<string, StoredLesson[]>;

/** Lessons saved before the feedback fields existed have none: they start with no evidence either way. */
function normalizeLesson(l: StoredLesson): StoredLesson {
  return { ...l, exposedSessionIds: l.exposedSessionIds ?? [], recurredSessionIds: l.recurredSessionIds ?? [], sessionIds: l.sessionIds ?? [] };
}

function readLessonStore(): LessonStore {
  try {
    const raw = JSON.parse(readFileSync(LESSONS_PATH, 'utf8')) as LessonStore;
    return Object.fromEntries(Object.entries(raw).map(([app, lessons]) => [app, lessons.map(normalizeLesson)]));
  } catch {
    return {};
  }
}

function writeLessonStore(store: LessonStore): void {
  mkdirSync(path.dirname(LESSONS_PATH), { recursive: true });
  writeFileSync(LESSONS_PATH, JSON.stringify(store, null, 2), 'utf8');
}

export function listLessons(appId: string): StoredLesson[] {
  return readLessonStore()[appId] ?? [];
}

/**
 * Files a session's drafts into the app's lessons and scores the lessons that
 * were in its briefings (core.ts scoreLessons). Returns how many are new and
 * which ones Bridget retired for not working.
 */
export function addLessons(
  appId: string,
  session: { id: string; startedAt: string },
  drafts: LessonDraft[],
): { lessons: StoredLesson[]; added: number; retired: StoredLesson[] } {
  const store = readLessonStore();
  const before = store[appId] ?? [];
  const now = new Date().toISOString();
  const merged = mergeLessonsDetailed(before, drafts, session.id, now, () => randomUUID().slice(0, 8));
  const scored = scoreLessons(merged.lessons, session, merged.matched);
  const known = new Set(before.map((l) => l.id));
  writeLessonStore({ ...store, [appId]: scored.lessons });
  return { lessons: scored.lessons, added: scored.lessons.filter((l) => !known.has(l.id)).length, retired: scored.retired };
}

/** Turns a lesson off (it stays on file so it isn't learned again) or back on. */
export function setLessonStatus(appId: string, lessonId: string, status: 'active' | 'dismissed'): StoredLesson[] {
  const store = readLessonStore();
  // Turning one back on gives it a clean record: the evidence that retired it was gathered under other conditions.
  const lessons = (store[appId] ?? []).map((l) =>
    l.id !== lessonId ? l : status === 'active' ? { ...l, status, exposedSessionIds: [], recurredSessionIds: [], retiredReason: undefined } : { ...l, status },
  );
  writeLessonStore({ ...store, [appId]: lessons });
  return lessons;
}

export function deleteLesson(appId: string, lessonId: string): StoredLesson[] {
  const store = readLessonStore();
  const lessons = (store[appId] ?? []).filter((l) => l.id !== lessonId);
  writeLessonStore({ ...store, [appId]: lessons });
  return lessons;
}

export interface StoredSuggestion extends SystemSuggestion {
  key: string;
  /** How many sessions raised it, this one included. */
  seenIn: number;
  status: SuggestionStatus;
  verdict: SuggestionVerdict;
}

type SuggestionStore = Record<string, TrackedSuggestion[]>;
const SUGGESTIONS_PATH = process.env.HARNESS_SUGGESTIONS_PATH ?? path.join(config.harnessRoot, 'backend', 'local-suggestions.json');

function readSuggestionStore(): SuggestionStore {
  try {
    return JSON.parse(readFileSync(SUGGESTIONS_PATH, 'utf8')) as SuggestionStore;
  } catch {
    return {};
  }
}

export function listTrackedSuggestions(appId: string): TrackedSuggestion[] {
  return readSuggestionStore()[appId] ?? [];
}

export function saveTrackedSuggestions(appId: string, tracked: TrackedSuggestion[]): void {
  mkdirSync(path.dirname(SUGGESTIONS_PATH), { recursive: true });
  writeFileSync(SUGGESTIONS_PATH, JSON.stringify({ ...readSuggestionStore(), [appId]: tracked }, null, 2), 'utf8');
}

export function updateSuggestionStatus(appId: string, key: string, status: SuggestionStatus): TrackedSuggestion[] {
  const next = setSuggestionStatus(listTrackedSuggestions(appId), key, status, new Date().toISOString());
  saveTrackedSuggestions(appId, next);
  return next;
}

/**
 * Makes the chosen suggestions part of what the agents are told next run: each
 * becomes an active lesson for every role (a pipeline change Riff can't make
 * itself still reaches the agents as an instruction) and the suggestion is
 * marked done, so later sessions show whether it helped.
 */
export function applySuggestions(appId: string, keys: string[]): { lessons: StoredLesson[]; tracked: TrackedSuggestion[]; applied: string[] } {
  const now = new Date().toISOString();
  const wanted = listTrackedSuggestions(appId).filter((t) => keys.includes(t.key) && t.status !== 'done');
  const store = readLessonStore();
  const lessons = [...(store[appId] ?? [])];
  for (const t of wanted) {
    const text = `${t.title.replace(/[.\s]+$/, '')}. ${t.detail}`.trim();
    lessons.push({
      id: randomUUID().slice(0, 8),
      text,
      category: 'process',
      area: null,
      source: 'model',
      status: 'active',
      exposedSessionIds: [],
      recurredSessionIds: [],
      seen: t.raisedIn.length || 1,
      sessionIds: [...t.raisedIn],
      firstAt: now,
      lastAt: now,
    });
  }
  writeLessonStore({ ...store, [appId]: lessons });
  let tracked = listTrackedSuggestions(appId);
  for (const t of wanted) tracked = setSuggestionStatus(tracked, t.key, 'done', now);
  saveTrackedSuggestions(appId, tracked);
  return { lessons, tracked, applied: wanted.map((t) => t.key) };
}

export interface RetrospectiveRecord {
  sessionId: string;
  appId: string;
  title: string;
  at: string;
  facts: RetroFacts;
  /** The model's read of what went wrong, or the rules' when none ran. */
  summary: string;
  lessonsAdded: number;
  lessons: { id: string; text: string }[];
  suggestions: StoredSuggestion[];
  modelUsed: boolean;
  /** Lessons this retrospective took out of the briefings because they weren't working. */
  lessonsRetired: { id: string; text: string; reason: string }[];
  /** Suggestions Bridget stopped making because nobody acted on them. */
  suggestionsMuted: { key: string; title: string; reason: string }[];
}

const retroPath = (sessionId: string) => path.join(RETRO_DIR, `${sessionId}.json`);

export function readRetrospective(sessionId: string): RetrospectiveRecord | null {
  try {
    return JSON.parse(readFileSync(retroPath(sessionId), 'utf8')) as RetrospectiveRecord;
  } catch {
    return null;
  }
}

export function writeRetrospective(record: RetrospectiveRecord): void {
  if (!existsSync(RETRO_DIR)) mkdirSync(RETRO_DIR, { recursive: true });
  writeFileSync(retroPath(record.sessionId), JSON.stringify(record, null, 2), 'utf8');
}

export function listRetrospectives(appId: string): RetrospectiveRecord[] {
  if (!existsSync(RETRO_DIR)) return [];
  return readdirSync(RETRO_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readRetrospective(f.slice(0, -5)))
    .filter((r): r is RetrospectiveRecord => r !== null && r.appId === appId)
    .sort((a, b) => b.at.localeCompare(a.at));
}
