import { promises as fs } from 'node:fs';
import { v4 as uuid } from 'uuid';
import { draftDeck, recreateSlide, type SlidesRequest } from '../agents/slides-agent.js';
import { findThemePreset, presetDefinition, THEME_PRESETS } from '../themes/presets.js';
import type { DeckSpec } from './deck-spec.js';
import { deckStyle, type DeckMode, type DeckStyle } from './deck-theme.js';
import { deckFileName, deckFilePath, loadJob, loadSource, loadSpec, saveJob, saveSource, saveSpec, type DeckJob } from './deck-store.js';
import { renderDeck } from './render-pptx.js';

const MIN_SLIDES = 3;

export class DeckError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

// A deck is edited one thing at a time: a rewrite takes a model call, and two
// edits racing would overwrite each other's spec.
const busy = new Set<string>();
async function exclusive<T>(id: string, work: () => Promise<T>): Promise<T> {
  if (busy.has(id)) throw new DeckError('This presentation is being changed. Try again in a moment.', 409);
  busy.add(id);
  try {
    return await work();
  } finally {
    busy.delete(id);
  }
}

export function resolveTheme(themeId: string | undefined) {
  const preset = (themeId && findThemePreset(themeId)) || THEME_PRESETS[0];
  return { themeId: preset.id, theme: presetDefinition(preset) };
}

export const styleOf = (job: DeckJob): DeckStyle => deckStyle(job.theme, job.mode);

async function writeFiles(job: DeckJob, spec: DeckSpec): Promise<DeckJob> {
  await saveSpec(job.id, spec);
  await fs.writeFile(deckFilePath(job.id), await renderDeck(spec, styleOf(job)));
  const done: DeckJob = { ...job, title: spec.title, status: 'done', progress: 'Done', error: undefined, slideCount: spec.slides.length, fileName: deckFileName(spec.title) };
  await saveJob(done);
  return done;
}

export interface CreateDeckInput extends SlidesRequest {
  sourceId: string;
  themeId?: string;
  mode?: DeckMode;
}

/** Starts a deck and returns at once; the draft runs in the background and reports through the job. */
export async function startDeck(input: CreateDeckInput): Promise<DeckJob> {
  const { sourceId, themeId, mode, ...source } = input;
  const job: DeckJob = {
    id: uuid(),
    title: source.title,
    sourceId,
    status: 'working',
    progress: 'Starting…',
    createdAt: new Date().toISOString(),
    ...resolveTheme(themeId),
    mode: mode ?? 'light',
  };
  await saveJob(job);
  await saveSource(job.id, source);
  void (async () => {
    try {
      const spec = await draftDeck(source, (progress) => void saveJob({ ...job, progress }));
      await saveJob({ ...job, progress: 'Building the PowerPoint…' });
      await writeFiles(job, spec);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[decks] failed:', message);
      await saveJob({ ...job, status: 'failed', progress: 'Failed', error: message });
    }
  })();
  return job;
}

async function loadDone(id: string) {
  const job = await loadJob(id);
  const spec = job?.status === 'done' ? await loadSpec(id) : null;
  if (!job || !spec) throw new DeckError('Presentation not found.', 404);
  return { job, spec };
}

export async function deckWithSlides(id: string) {
  const { job, spec } = await loadDone(id);
  return { job, slides: spec.slides, style: styleOf(job) };
}

export function recreateDeckSlide(id: string, index: number, instruction: string) {
  return exclusive(id, async () => {
    const { job, spec } = await loadDone(id);
    const source = await loadSource(id);
    if (!source) throw new DeckError("The journal text this deck came from is gone, so Sasha can't rewrite a slide.", 410);
    if (!Number.isInteger(index) || index < 0 || index >= spec.slides.length) throw new DeckError('No such slide.', 404);
    const slide = await recreateSlide(source, spec, index, instruction);
    const slides = spec.slides.map((s, i) => (i === index ? slide : s));
    return writeFiles(job, { ...spec, slides });
  });
}

export function deleteDeckSlide(id: string, index: number) {
  return exclusive(id, async () => {
    const { job, spec } = await loadDone(id);
    if (!Number.isInteger(index) || index < 0 || index >= spec.slides.length) throw new DeckError('No such slide.', 404);
    if (index === 0 || index === spec.slides.length - 1) throw new DeckError('The first and last slides stay; recreate them instead.', 400);
    if (spec.slides.length <= MIN_SLIDES) throw new DeckError(`A presentation needs at least ${MIN_SLIDES} slides.`, 400);
    return writeFiles(job, { ...spec, slides: spec.slides.filter((_, i) => i !== index) });
  });
}

export function restyleDeck(id: string, themeId: string, mode: DeckMode) {
  return exclusive(id, async () => {
    const { job, spec } = await loadDone(id);
    if (!findThemePreset(themeId)) throw new DeckError('Unknown theme.', 400);
    return writeFiles({ ...job, ...resolveTheme(themeId), mode }, spec);
  });
}
