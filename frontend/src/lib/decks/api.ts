import { apiUrl } from '@/lib/dev-sessions/api';
import type { ThemeMode } from '@/lib/dev-sessions/types';

export type DeckLength = 'short' | 'standard' | 'detailed';

export interface DeckJob {
  id: string;
  title: string;
  sourceId: string;
  status: 'working' | 'done' | 'failed';
  progress: string;
  error?: string;
  slideCount?: number;
  fileName?: string;
  createdAt: string;
  themeId: string;
  mode: ThemeMode;
}

/** Every layout's fields in one shape; only the ones a layout uses are set. Mirrors harness-server decks/deck-spec.ts. */
export interface DeckSlide {
  layout: 'title' | 'section' | 'bullets' | 'two_column' | 'stat' | 'quote' | 'table' | 'closing';
  title?: string;
  subtitle?: string;
  bullets?: string[];
  left?: { heading: string; bullets: string[] };
  right?: { heading: string; bullets: string[] };
  stats?: { value: string; label: string }[];
  quote?: string;
  attribution?: string;
  columns?: string[];
  rows?: string[][];
  notes?: string;
}

/** The theme's colors (#rrggbb) and fonts for the mode the deck is drawn in. */
export interface DeckStyle {
  bg: string;
  surface: string;
  surfaceMuted: string;
  border: string;
  text: string;
  textMuted: string;
  primary: string;
  onPrimary: string;
  headingFont: string;
  bodyFont: string;
}

export interface DeckWithSlides {
  job: DeckJob;
  slides: DeckSlide[];
  style: DeckStyle;
}

export interface CreateDeckInput {
  title: string;
  sourceId: string;
  notes: string;
  overview?: string | null;
  covers?: string;
  audience: string;
  length: DeckLength;
  speakerNotes: boolean;
  focus?: string;
  themeId: string;
  mode: ThemeMode;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    // Fastify's own 404 (as opposed to ours) means the running agent server predates this feature.
    if (res.status === 404 && typeof body.message === 'string' && body.message.startsWith('Route ')) {
      throw new Error('The agent server is out of date. Restart Riff (or the agent server on the Dev Sessions page) and try again.');
    }
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

const send = (path: string, method: string, body?: unknown) =>
  fetch(apiUrl(path), {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

export const decksApi = {
  create: (input: CreateDeckInput) => send('/api/decks', 'POST', input).then((r) => json<DeckJob>(r)),

  list: (sourceId: string) => fetch(apiUrl(`/api/decks?sourceId=${encodeURIComponent(sourceId)}`)).then((r) => json<DeckJob[]>(r)),

  get: (id: string) => fetch(apiUrl(`/api/decks/${id}`)).then((r) => json<DeckJob>(r)),

  slides: (id: string) => fetch(apiUrl(`/api/decks/${id}/slides`)).then((r) => json<DeckWithSlides>(r)),

  recreateSlide: (id: string, index: number, instruction: string) =>
    send(`/api/decks/${id}/slides/${index}/recreate`, 'POST', { instruction }).then((r) => json<DeckWithSlides>(r)),

  deleteSlide: (id: string, index: number) =>
    send(`/api/decks/${id}/slides/${index}`, 'DELETE').then((r) => json<DeckWithSlides>(r)),

  setTheme: (id: string, themeId: string, mode: ThemeMode) =>
    send(`/api/decks/${id}/theme`, 'PUT', { themeId, mode }).then((r) => json<DeckWithSlides>(r)),

  remove: (id: string) =>
    send(`/api/decks/${id}`, 'DELETE').then(async (r) => {
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `Request failed: ${r.status}`);
    }),

  fileUrl: (id: string) => apiUrl(`/api/decks/${id}/file`),
};
