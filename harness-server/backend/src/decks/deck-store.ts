import { promises as fs } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import type { SlidesRequest } from '../agents/slides-agent.js';
import type { ThemeDefinition } from '../themes/presets.js';
import type { DeckSpec } from './deck-spec.js';
import type { DeckMode } from './deck-theme.js';

// One folder per deck under state/decks/<id>/: job.json (status and theme),
// spec.json (what the slides say), source.json (the journal text the agent
// worked from, so a slide can be rewritten later) and deck.pptx.

export interface DeckJob {
  id: string;
  title: string;
  /** The journal it came from. */
  sourceId: string;
  status: 'working' | 'done' | 'failed';
  progress: string;
  error?: string;
  slideCount?: number;
  fileName?: string;
  createdAt: string;
  /** Preset the theme started from, and a copy of it, so a later preset change doesn't restyle old decks. */
  themeId: string;
  theme: ThemeDefinition;
  mode: DeckMode;
}

const jobs = new Map<string, DeckJob>();

const safeId = (id: string) => /^[A-Za-z0-9-]{8,64}$/.test(id);
const dir = (id: string) => path.join(config.decksDir, id);
export const deckFilePath = (id: string) => path.join(dir(id), 'deck.pptx');

async function writeJson(id: string, name: string, value: unknown) {
  await fs.mkdir(dir(id), { recursive: true });
  await fs.writeFile(path.join(dir(id), name), JSON.stringify(value, null, 2));
}

async function readJson<T>(id: string, name: string): Promise<T | null> {
  if (!safeId(id)) return null;
  try {
    return JSON.parse(await fs.readFile(path.join(dir(id), name), 'utf8')) as T;
  } catch {
    return null;
  }
}

export async function saveJob(job: DeckJob): Promise<void> {
  jobs.set(job.id, job);
  await writeJson(job.id, 'job.json', job);
}

export async function loadJob(id: string): Promise<DeckJob | null> {
  const live = jobs.get(id);
  if (live) return live;
  const job = await readJson<DeckJob>(id, 'job.json');
  // A job still "working" on disk belongs to a server that has since stopped.
  return job && job.status === 'working' ? { ...job, status: 'failed', error: 'Interrupted by a restart.' } : job;
}

export const saveSpec = (id: string, spec: DeckSpec) => writeJson(id, 'spec.json', spec);
export const loadSpec = (id: string) => readJson<DeckSpec>(id, 'spec.json');
export const saveSource = (id: string, source: SlidesRequest) => writeJson(id, 'source.json', source);
export const loadSource = (id: string) => readJson<SlidesRequest>(id, 'source.json');

export async function listJobs(sourceId: string): Promise<DeckJob[]> {
  const ids = await fs.readdir(config.decksDir).catch(() => [] as string[]);
  const all = await Promise.all(ids.filter(safeId).map(loadJob));
  return all
    .filter((j): j is DeckJob => j !== null && j.sourceId === sourceId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function deleteDeck(id: string): Promise<boolean> {
  if (!safeId(id) || !(await loadJob(id))) return false;
  jobs.delete(id);
  await fs.rm(dir(id), { recursive: true, force: true });
  return true;
}

/** A file name safe on every OS, from the deck's title. */
export function deckFileName(title: string): string {
  const stem = title.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return `${stem || 'presentation'}.pptx`;
}
