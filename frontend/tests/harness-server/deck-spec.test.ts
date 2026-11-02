import { describe, expect, test } from 'bun:test';
import JSZip from '../../../harness-server/node_modules/jszip';
import { deckProblems, parseDeckSpec, trimToLength, type DeckSpec } from '../../../harness-server/backend/src/decks/deck-spec';
import { renderDeck } from '../../../harness-server/backend/src/decks/render-pptx';
import { deckStyle, firstFamily } from '../../../harness-server/backend/src/decks/deck-theme';
import { THEME_PRESETS } from '../../../harness-server/backend/src/themes/presets';
import { slidesPrompt } from '../../../harness-server/backend/src/agents/slides-agent';

const deck = (over: Partial<DeckSpec> = {}): DeckSpec => ({
  title: 'Checkout rebuild',
  slides: [
    { layout: 'title', title: 'Checkout rebuild', subtitle: 'Jan - Mar' },
    { layout: 'bullets', title: 'Errors fell after the retry fix', bullets: ['Retries added', 'Errors down'], notes: 'Say this.' },
    { layout: 'stat', title: 'Results', stats: [{ value: '42%', label: 'fewer errors' }] },
    { layout: 'table', title: 'Owners', columns: ['Task', 'Owner'], rows: [['Retry', 'Sam']] },
    { layout: 'two_column', title: 'Before and after', left: { heading: 'Before', bullets: ['Slow'] }, right: { heading: 'After', bullets: ['Fast'] } },
    { layout: 'quote', quote: 'It just works now.', attribution: 'Sam' },
    { layout: 'closing', title: 'Next steps', bullets: ['Ship it'] },
  ],
  ...over,
});

describe('parseDeckSpec', () => {
  test('accepts a valid deck, with prose around the JSON', () => {
    const parsed = parseDeckSpec(`Here:\n${JSON.stringify(deck())}`);
    expect('spec' in parsed).toBe(true);
  });

  test('names what is wrong', () => {
    const bad = deck();
    (bad.slides[3] as { rows: string[][] }).rows = [['only one']];
    const parsed = parseDeckSpec(JSON.stringify(bad));
    expect('errors' in parsed && parsed.errors.length > 0).toBe(true);
  });

  test('shortens over-long text instead of rejecting the deck', () => {
    const d = deck();
    const long = 'word '.repeat(30).trim();
    (d.slides[3] as { rows: string[][] }).rows = [[long, long]];
    const parsed = parseDeckSpec(JSON.stringify(d));
    expect('spec' in parsed).toBe(true);
    if ('spec' in parsed) {
      const cell = (parsed.spec.slides[3] as { rows: string[][] }).rows[0][0];
      expect(cell.length).toBeLessThanOrEqual(60);
      expect(cell.endsWith('…')).toBe(true);
    }
  });

  test('rejects non-JSON', () => {
    expect(parseDeckSpec('sorry')).toEqual({ errors: ['The reply was not a single valid JSON object.'] });
  });
});

describe('deckProblems', () => {
  test('a good deck of the right length has none', () => {
    expect(deckProblems(deck(), 'short')).toEqual([]);
  });

  test('flags length, ends and repeated layouts', () => {
    const d = deck();
    expect(deckProblems(d, 'detailed')).toEqual([]);
    const long = deck({ slides: [d.slides[0], ...Array.from({ length: 8 }, (_, i) => (i % 2 ? d.slides[2] : d.slides[1])), d.slides[6]] });
    expect(deckProblems(long, 'short').join()).toContain('at most 7');
    const bullets = { layout: 'bullets' as const, title: 't', bullets: ['a'] };
    const repeated = deck({ slides: [d.slides[0], bullets, bullets, bullets, bullets, d.slides[6]] });
    expect(deckProblems(repeated, 'short').join()).toContain('Vary the layouts');
    const noClose = deck({ slides: d.slides.slice(0, 5) });
    expect(deckProblems(noClose, 'short').join()).toContain('closing');
  });
});

describe('trimToLength', () => {
  test('drops dividers and quotes first and keeps the first and last slide', () => {
    const d = deck();
    const section = { layout: 'section' as const, title: 'Part two' };
    const trimmed = trimToLength(deck({ slides: [d.slides[0], d.slides[1], section, d.slides[2], d.slides[5], d.slides[3], d.slides[4], d.slides[6]] }), 'short');
    expect(trimmed.slides.length).toBe(7);
    expect(trimmed.slides.some((s) => s.layout === 'section')).toBe(false);
    expect(trimmed.slides[0].layout).toBe('title');
    expect(trimmed.slides[trimmed.slides.length - 1].layout).toBe('closing');
  });
});

describe('slidesPrompt', () => {
  test('carries audience, range and the notes request', () => {
    const p = slidesPrompt({ title: 'J', notes: 'n', audience: 'execs', length: 'short', speakerNotes: false });
    expect(p).toContain('execs');
    expect(p).toContain('at most 7');
    expect(p).toContain('leave "notes" out');
  });
});

describe('renderDeck', () => {
  test('writes one slide per spec slide, with speaker notes', async () => {
    const buf = await renderDeck(deck(), deckStyle(THEME_PRESETS[0], 'light'));
    const zip = await JSZip.loadAsync(buf);
    const slides = Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f));
    expect(slides.length).toBe(7);
    const notes = await Promise.all(
      Object.keys(zip.files)
        .filter((f) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(f))
        .map((f) => zip.files[f].async('string')),
    );
    expect(notes.some((xml) => xml.includes('Say this.'))).toBe(true);
  });
});

describe('deckStyle', () => {
  test('takes one mode of the theme, and a named font over system ones', () => {
    const preset = THEME_PRESETS[0];
    const dark = deckStyle(preset, 'dark');
    expect(dark.bg).toBe(preset.dark.bg);
    expect(dark.primary).toBe(preset.dark.primary);
    expect(firstFamily('Inter, ui-sans-serif, system-ui')).toBe('Inter');
    expect(firstFamily('"DM Serif Display", serif')).toBe('DM Serif Display');
    expect(firstFamily('ui-sans-serif, system-ui, Arial')).toBe('Calibri');
  });

  test('every slide is drawn on the theme background (accent for the opening) in both modes', async () => {
    for (const mode of ['light', 'dark'] as const) {
      const style = deckStyle(THEME_PRESETS[1], mode);
      const zip = await JSZip.loadAsync(await renderDeck(deck(), style));
      const slides = Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f));
      for (const [i, f] of slides.sort().entries()) {
        const xml = await zip.files[f].async('string');
        // The title slide is full-bleed accent; the rest sit on the page color.
        const fill = i === 0 ? style.primary : style.bg;
        expect(xml.toUpperCase()).toContain(`<A:SRGBCLR VAL="${fill.replace('#', '').toUpperCase()}"`);
      }
    }
  });
});
