import { z } from 'zod';

// The contract between the slides agent (agents/slides-agent.ts) and the
// renderer (decks/render-pptx.ts): the agent decides what each slide says and
// which layout carries it, never how it is drawn (colors and fonts come from
// the theme the human picked: decks/deck-theme.ts). Limits here are the layout
// rules the renderer's boxes were sized for; over-long text is shortened while
// parsing, so a spec that parses always fits.

export const LENGTHS = ['short', 'standard', 'detailed'] as const;
export type DeckLength = (typeof LENGTHS)[number];

/** Slide counts the agent is asked to land on, content slides plus title and closing. */
export const LENGTH_SLIDES: Record<DeckLength, { min: number; max: number }> = {
  short: { min: 4, max: 7 },
  standard: { min: 8, max: 12 },
  detailed: { min: 13, max: 20 },
};

/** Text over a box's limit is shortened at a word with an ellipsis instead of failing the whole deck. */
export function fit(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd().replace(/[,;:.\-–—]$/, '')}…`;
}

const line = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .transform((s) => fit(s, max));
const notes = z
  .string()
  .trim()
  .transform((s) => fit(s, 1500))
  .optional();

const bullets = z.array(line(80)).min(1).max(4);

const titleSlide = z.object({
  layout: z.literal('title'),
  title: line(70),
  subtitle: line(100).optional(),
  notes,
});
const sectionSlide = z.object({
  layout: z.literal('section'),
  title: line(60),
  subtitle: line(100).optional(),
  notes,
});
const bulletsSlide = z.object({
  layout: z.literal('bullets'),
  title: line(70),
  bullets,
  notes,
});
const twoColumnSlide = z.object({
  layout: z.literal('two_column'),
  title: line(70),
  left: z.object({ heading: line(30), bullets: z.array(line(70)).min(1).max(3) }),
  right: z.object({ heading: line(30), bullets: z.array(line(70)).min(1).max(3) }),
  notes,
});
const statSlide = z.object({
  layout: z.literal('stat'),
  title: line(70),
  stats: z.array(z.object({ value: line(12), label: line(50) })).min(1).max(3),
  notes,
});
const quoteSlide = z.object({
  layout: z.literal('quote'),
  quote: line(160),
  attribution: line(80).optional(),
  notes,
});
const tableSlide = z.object({
  layout: z.literal('table'),
  title: line(70),
  columns: z.array(line(24)).min(2).max(4),
  rows: z.array(z.array(line(40)).min(2).max(4)).min(1).max(5),
  notes,
});
const statementSlide = z.object({
  layout: z.literal('statement'),
  statement: line(110),
  subtitle: line(80).optional(),
  notes,
});
const timelineSlide = z.object({
  layout: z.literal('timeline'),
  title: line(70),
  events: z.array(z.object({ when: line(14), label: line(48) })).min(2).max(5),
  notes,
});
const processSlide = z.object({
  layout: z.literal('process'),
  title: line(70),
  steps: z.array(z.object({ title: line(24), detail: line(60).optional() })).min(2).max(4),
  notes,
});
const barChartSlide = z.object({
  layout: z.literal('bar_chart'),
  title: line(70),
  items: z.array(z.object({ label: line(28), value: z.number().finite().nonnegative(), display: line(12).optional() })).min(2).max(6),
  highlight: z.number().int().nonnegative().optional(),
  caption: line(80).optional(),
  notes,
});
const statusListSlide = z.object({
  layout: z.literal('status_list'),
  title: line(70),
  items: z.array(z.object({ label: line(64), status: z.enum(['done', 'open', 'risk']) })).min(2).max(5),
  notes,
});
const closingSlide = z.object({
  layout: z.literal('closing'),
  title: line(70),
  bullets: z.array(line(80)).max(3).optional(),
  notes,
});

export const slideSchema = z
  .discriminatedUnion('layout', [
    titleSlide,
    sectionSlide,
    bulletsSlide,
    twoColumnSlide,
    statSlide,
    quoteSlide,
    tableSlide,
    statementSlide,
    timelineSlide,
    processSlide,
    barChartSlide,
    statusListSlide,
    closingSlide,
  ])
  .superRefine((slide, ctx) => {
    if (slide.layout === 'bar_chart' && slide.highlight !== undefined && slide.highlight >= slide.items.length) {
      ctx.addIssue({ code: 'custom', message: `highlight ${slide.highlight} is not an item index`, path: ['highlight'] });
    }
    if (slide.layout !== 'table') return;
    // A ragged table would render with holes; make the agent fix it.
    slide.rows.forEach((row, i) => {
      if (row.length !== slide.columns.length) {
        ctx.addIssue({
          code: 'custom',
          message: `row ${i + 1} has ${row.length} cells but there are ${slide.columns.length} columns`,
          path: ['rows', i],
        });
      }
    });
  });

export type Slide = z.infer<typeof slideSchema>;

export const deckSpecSchema = z.object({
  title: line(100),
  subtitle: line(160).optional(),
  slides: z.array(slideSchema).min(3).max(30),
});

export type DeckSpec = z.infer<typeof deckSpecSchema>;

/** First JSON object in a model reply, parsed and checked. `errors` is what the agent is told to fix. */
export function parseDeckSpec(raw: string): { spec: DeckSpec } | { errors: string[] } {
  let json: unknown;
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    json = JSON.parse(match ? match[0] : raw);
  } catch {
    return { errors: ['The reply was not a single valid JSON object.'] };
  }
  const parsed = deckSpecSchema.safeParse(json);
  if (parsed.success) return { spec: parsed.data };
  return {
    errors: parsed.error.issues.slice(0, 12).map((issue) => `${issue.path.join('.') || '(deck)'}: ${issue.message}`),
  };
}

/** Words a slide puts in front of the audience (speaker notes excluded). */
export function slideWords(slide: Slide): number {
  const { notes: _notes, layout: _layout, ...visible } = slide as Slide & { notes?: string };
  const strings: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === 'string') strings.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(visible);
  return strings.join(' ').split(/\s+/).filter(Boolean).length;
}

/** The most words a slide may carry: enough for a claim and its proof, little enough that most of the page stays empty. */
export const WORD_BUDGET = 32;

/** Problems with the deck as a whole (not one slide) that the agent should fix. */
export function deckProblems(spec: DeckSpec, length: DeckLength): string[] {
  const problems: string[] = [];
  const { max } = LENGTH_SLIDES[length];
  // Under the range is fine: a thin journal makes a short deck. Only too long is a problem.
  if (spec.slides.length > max) {
    problems.push(`The deck has ${spec.slides.length} slides; "${length}" allows at most ${max}. Merge or cut ${spec.slides.length - max}.`);
  }
  if (spec.slides[0]?.layout !== 'title') problems.push('The first slide must use the "title" layout.');
  if (spec.slides[spec.slides.length - 1]?.layout !== 'closing') problems.push('The last slide must use the "closing" layout.');
  const inner = spec.slides.slice(1, -1);
  if (inner.some((s) => s.layout === 'title' || s.layout === 'closing')) {
    problems.push('"title" and "closing" layouts are only for the first and last slide.');
  }
  spec.slides.forEach((s, i) => {
    if (s.layout === 'table' || s.layout === 'title' || s.layout === 'closing') return;
    const words = slideWords(s);
    if (words > WORD_BUDGET) problems.push(`Slide ${i + 1} has ${words} words; keep it under ${WORD_BUDGET}. Cut words or move detail to the speaker notes.`);
    if (s.layout === 'bullets' && s.bullets.length > 3) problems.push(`Slide ${i + 1} has ${s.bullets.length} bullets; use at most 3.`);
  });
  // Same layout three times running reads as a wall of bullets.
  let run = 1;
  for (let i = 1; i < spec.slides.length; i++) {
    run = spec.slides[i].layout === spec.slides[i - 1].layout ? run + 1 : 1;
    if (run === 3) {
      problems.push(`Slides ${i - 1}-${i + 1} all use "${spec.slides[i].layout}". Vary the layouts.`);
      break;
    }
  }
  return problems;
}

/** Slides to give up first when a deck is over length: dividers, then quotes, then the middle from the back. */
export function trimToLength(spec: DeckSpec, length: DeckLength): DeckSpec {
  const { max } = LENGTH_SLIDES[length];
  const slides = [...spec.slides];
  const drop = (pick: (s: Slide, i: number) => boolean) => {
    for (let i = slides.length - 2; i > 0 && slides.length > max; i--) {
      if (pick(slides[i], i)) slides.splice(i, 1);
    }
  };
  drop((s) => s.layout === 'section');
  drop((s) => s.layout === 'quote');
  drop(() => true);
  return { ...spec, slides };
}

/** A valid placeholder slide for a layout, for a human to fill in. */
export function blankSlide(layout: Slide['layout']): Slide {
  const title = 'New slide';
  const pair = { heading: 'Heading', bullets: ['Point'] };
  switch (layout) {
    case 'title':
    case 'section':
      return { layout, title };
    case 'bullets':
      return { layout, title, bullets: ['Point'] };
    case 'two_column':
      return { layout, title, left: pair, right: pair };
    case 'stat':
      return { layout, title, stats: [{ value: '0', label: 'Label' }] };
    case 'quote':
      return { layout, quote: 'Quote' };
    case 'table':
      return { layout, title, columns: ['Column 1', 'Column 2'], rows: [['Cell', 'Cell']] };
    case 'statement':
      return { layout, statement: 'Statement' };
    case 'timeline':
      return { layout, title, events: [{ when: 'Now', label: 'Event' }, { when: 'Next', label: 'Event' }] };
    case 'process':
      return { layout, title, steps: [{ title: 'Step 1' }, { title: 'Step 2' }] };
    case 'bar_chart':
      return { layout, title, items: [{ label: 'A', value: 1 }, { label: 'B', value: 2 }] };
    case 'status_list':
      return { layout, title, items: [{ label: 'Item', status: 'open' }, { label: 'Item', status: 'done' }] };
    case 'closing':
      return { layout, title: 'Thank you' };
  }
}
