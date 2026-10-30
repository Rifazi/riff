import { promises as fs } from 'node:fs';
import path from 'node:path';
import { generateText } from 'ai';
import { config } from '../config.js';
import { getApiKey, getRoleModelConfig } from '../settings/settings-store.js';
import type { ApiKeyProvider } from '../settings/settings.js';
import { deckProblems, LENGTH_SLIDES, parseDeckSpec, slideSchema, trimToLength, type DeckLength, type DeckSpec, type Slide } from '../decks/deck-spec.js';
import { resolveLanguageModel, runClaudeSingleShot } from './sdk-client.js';

const PROMPT_PATH = path.join(config.harnessRoot, 'backend/src/agents/prompts/slides-agent.md');

// The journal text sent to the model; the rest is cut with a note, since a
// deck is a summary and a model's window isn't unlimited.
const MAX_SOURCE_CHARS = 60_000;
const MAX_ATTEMPTS = 2;

export interface SlidesRequest {
  title: string;
  /** The journal's dated notes, as one markdown document. */
  notes: string;
  /** The journal's overview, when it has one. */
  overview?: string | null;
  covers?: string;
  audience: string;
  length: DeckLength;
  speakerNotes: boolean;
  /** What the human wants emphasised or left out. */
  focus?: string;
}

export function slidesPrompt(req: SlidesRequest): string {
  const { min, max } = LENGTH_SLIDES[req.length];
  const clipped = req.notes.length > MAX_SOURCE_CHARS;
  const notes = clipped ? `${req.notes.slice(0, MAX_SOURCE_CHARS)}\n\n[Notes cut here: the journal is longer than fits.]` : req.notes;
  return [
    `Journal: ${req.title}${req.covers ? ` (${req.covers})` : ''}`,
    `Audience: ${req.audience.trim() || 'general'}`,
    `Slide count: at most ${max}, ideally ${min}-${max} (${req.length}). Count your slides before replying; going over is rejected.`,
    `Speaker notes: ${req.speakerNotes ? 'yes, on every slide' : 'no, leave "notes" out'}`,
    req.focus?.trim() ? `The human asks: ${req.focus.trim()}` : '',
    req.overview?.trim() ? `\n## Journal overview\n${req.overview.trim()}` : '',
    `\n## Journal notes\n${notes}`,
    '\nWrite the JSON deck.',
  ]
    .filter(Boolean)
    .join('\n');
}

async function ask(system: string, prompt: string): Promise<string> {
  // Writing the deck is the requirements role's kind of work (turn messy
  // notes into a structured document), so it runs on that role's model.
  const { provider, model } = await getRoleModelConfig('requirements');
  if (provider === 'claude') return runClaudeSingleShot({ systemPrompt: system, prompt, model, effort: 'medium' });
  const apiKey = await getApiKey(provider);
  if (apiKey === null) throw new Error(`No API key for ${provider}. Add one in Settings → Dev Agents.`);
  const languageModel = await resolveLanguageModel(provider as ApiKeyProvider, model, apiKey);
  const { text } = await generateText({ model: languageModel, system, prompt });
  return text;
}

/** Drafts the deck, and when it breaks a rule asks the model to fix exactly that, up to twice. */
export async function draftDeck(req: SlidesRequest, onStatus: (text: string) => void = () => {}): Promise<DeckSpec> {
  const system = await fs.readFile(PROMPT_PATH, 'utf8');
  const finish = (spec: DeckSpec): DeckSpec =>
    req.speakerNotes ? spec : { ...spec, slides: spec.slides.map((s) => ({ ...s, notes: undefined })) };
  let prompt = slidesPrompt(req);
  let problems: string[] = [];
  let overLong: DeckSpec | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    onStatus(attempt === 1 ? 'Sasha is writing the deck…' : 'Sasha is fixing a few things…');
    const parsed = parseDeckSpec(await ask(system, prompt));
    problems = 'errors' in parsed ? parsed.errors : deckProblems(parsed.spec, req.length);
    if (!('errors' in parsed) && problems.length === 0) return finish(parsed.spec);
    // A deck whose only fault is being too long is trimmed rather than thrown away.
    overLong = 'spec' in parsed && problems.every((p) => p.includes('allows at most')) ? parsed.spec : null;
    prompt = `${slidesPrompt(req)}\n\nYour previous deck was rejected:\n${problems.map((p) => `- ${p}`).join('\n')}\n\nReturn the whole corrected JSON deck.`;
  }
  if (overLong) return finish(trimToLength(overLong, req.length));
  throw new Error(`Sasha could not produce a valid deck: ${problems.slice(0, 3).join('; ')}`);
}

const SINGLE_SLIDE_NOTE = `

## Rewriting one slide

You are given a finished deck's outline, the slide to rewrite, and sometimes an instruction. Reply with ONLY the one replacement slide as a JSON object (just the slide, not the deck). Keep it consistent with the neighbouring slides, do not repeat what they already say, and follow the same rules (facts only, length limits). With no instruction, take a different angle or layout that serves the same point better. The slide keeps its place in the story: the first slide stays a "title" layout, the last a "closing" layout, and no other slide may use either.`;

function outline(deck: DeckSpec, index: number): string {
  return deck.slides
    .map((s, i) => `${i + 1}. [${s.layout}] ${'title' in s ? s.title : s.quote.slice(0, 80)}${i === index ? '   <- rewrite this one' : ''}`)
    .join('\n');
}

function slideProblem(slide: Slide, index: number, total: number): string | null {
  const first = index === 0;
  const last = index === total - 1;
  if (first && slide.layout !== 'title') return 'This is the first slide, so it must use the "title" layout.';
  if (last && slide.layout !== 'closing') return 'This is the last slide, so it must use the "closing" layout.';
  if (!first && !last && (slide.layout === 'title' || slide.layout === 'closing')) return 'A middle slide cannot use the "title" or "closing" layout.';
  return null;
}

/** Sasha rewrites one slide of a finished deck, keeping it consistent with the rest. */
export async function recreateSlide(
  req: SlidesRequest,
  deck: DeckSpec,
  index: number,
  instruction: string,
): Promise<Slide> {
  const system = (await fs.readFile(PROMPT_PATH, 'utf8')) + SINGLE_SLIDE_NOTE;
  const base = [
    slidesPrompt(req).replace(/\nWrite the JSON deck\.$/, ''),
    `\n## The deck so far\n${outline(deck, index)}`,
    `\n## The slide to rewrite (slide ${index + 1})\n${JSON.stringify(deck.slides[index])}`,
    instruction.trim() ? `\nThe human asks: ${instruction.trim()}` : '',
    '\nWrite the replacement slide as one JSON object.',
  ].join('\n');
  let prompt = base;
  let problems: string[] = [];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const reply = await ask(system, prompt);
    try {
      const match = reply.match(/\{[\s\S]*\}/);
      const parsed = slideSchema.safeParse(JSON.parse(match ? match[0] : reply));
      if (parsed.success) {
        const problem = slideProblem(parsed.data, index, deck.slides.length);
        if (!problem) return req.speakerNotes ? parsed.data : { ...parsed.data, notes: undefined };
        problems = [problem];
      } else {
        problems = parsed.error.issues.slice(0, 8).map((i) => `${i.path.join('.') || '(slide)'}: ${i.message}`);
      }
    } catch {
      problems = ['The reply was not a single valid JSON object.'];
    }
    prompt = `${base}\n\nYour previous slide was rejected:\n${problems.map((p) => `- ${p}`).join('\n')}\n\nReturn the corrected slide as one JSON object.`;
  }
  throw new Error(`Sasha could not rewrite the slide: ${problems.slice(0, 3).join('; ')}`);
}
