import PptxGenJSModule from 'pptxgenjs';
import type { DeckSpec, Slide } from './deck-spec.js';
import type { DeckStyle } from './deck-theme.js';

// The package's own types differ between module resolutions (the server's and
// the frontend test typecheck's), so this is the slice of it the renderer uses.
type Opts = Record<string, unknown>;
type TextRun = { text: string; options: Opts };
interface PptxSlide {
  background: { color: string };
  addText(text: string | TextRun[], options?: Opts): unknown;
  addShape(shape: string, options?: Opts): unknown;
  addTable(rows: unknown[][], options?: Opts): unknown;
  addNotes(notes: string): unknown;
}
interface Pptx {
  layout: string;
  title: string;
  author: string;
  addSlide(): PptxSlide;
  write(options: { outputType: string }): Promise<unknown>;
}
const PptxGenJS = PptxGenJSModule as unknown as new () => Pptx;

const W = 13.33;
const H = 7.5;

// One grid for every slide. Text boxes have no inset (margin: 0), so text, rules
// and shapes all start on the same left edge. Spacing comes from this scale only.
const MARGIN = 1.0;
const CONTENT_W = W - MARGIN * 2;
const MEASURE = 9.6; // widest a block of reading text runs; the rest stays empty
const GAP = { s: 0.2, m: 0.5, l: 1.0 };
const TOP = 0.8; // accent rule
const TITLE_Y = 1.1;
const BODY_Y = 2.75;
const FOOT_Y = H - 0.65;

// Type scale: 72 / 40 / 32 / 24 / 18 / 12. Nothing else is used.
const SIZE = { hero: 72, display: 40, title: 32, body: 24, small: 18, caption: 12 };

// pptxgenjs wants hex without the "#".
const hex = (color: string) => color.replace('#', '').toUpperCase();

interface Colors {
  bg: string;
  surface: string;
  border: string;
  text: string;
  muted: string;
  primary: string;
  onPrimary: string;
  head: string;
  body: string;
}

const colorsOf = (s: DeckStyle): Colors => ({
  bg: hex(s.bg),
  surface: hex(s.surface),
  border: hex(s.border),
  text: hex(s.text),
  muted: hex(s.textMuted),
  primary: hex(s.primary),
  onPrimary: hex(s.onPrimary),
  head: s.headingFont,
  body: s.bodyFont,
});

// Display text is set slightly tight with a tight line height, body text open.
const DISPLAY = { margin: 0, bold: true, charSpacing: -1, lineSpacingMultiple: 0.92, valign: 'top', fit: 'shrink' };
const BODY = { margin: 0, lineSpacingMultiple: 1.2, valign: 'top', fit: 'shrink' };

const bulletRuns = (items: string[], size: number, color: string, face: string, after = 18): TextRun[] =>
  items.map((text, i) => ({
    text,
    options: { bullet: { indent: 22 }, breakLine: i < items.length - 1, fontSize: size, color, fontFace: face, paraSpaceAfter: after },
  }));

const rule = (slide: PptxSlide, x: number, y: number, w: number, color: string, h = 0.05) =>
  slide.addShape('rect', { x, y, w, h, fill: { color }, line: { color, width: 0 } });

/** Content slides: accent rule, then the takeaway title, both on the left margin. */
function heading(slide: PptxSlide, title: string, c: Colors) {
  rule(slide, MARGIN, TOP, 0.6, c.primary, 0.06);
  slide.addText(title, { ...DISPLAY, x: MARGIN, y: TITLE_Y, w: MEASURE + 1, h: 1.4, fontSize: SIZE.title, fontFace: c.head, color: c.text });
}

function footer(slide: PptxSlide, index: number, total: number, deckTitle: string, color: string, c: Colors) {
  slide.addText(deckTitle, { margin: 0, x: MARGIN, y: FOOT_Y, w: 8, h: 0.3, fontSize: SIZE.caption, color, fontFace: c.body, valign: 'middle' });
  slide.addText(`${index} / ${total}`, { margin: 0, x: W - MARGIN - 1.5, y: FOOT_Y, w: 1.5, h: 0.3, fontSize: SIZE.caption, color, align: 'right', fontFace: c.body, valign: 'middle' });
}

function drawSlide(pptx: Pptx, deck: DeckSpec, s: Slide, index: number, c: Colors) {
  const slide = pptx.addSlide();
  // The opening and the dividers are full-bleed accent; everything else sits on the page color.
  const bold = s.layout === 'title' || s.layout === 'section';
  slide.background = { color: bold ? c.primary : c.bg };
  const ink = bold ? c.onPrimary : c.text;

  switch (s.layout) {
    case 'title':
      rule(slide, MARGIN, 2.9, 0.9, c.onPrimary, 0.08);
      slide.addText(s.title, { ...DISPLAY, x: MARGIN, y: 3.2, w: MEASURE + 1, h: 2.0, fontSize: SIZE.hero - 12, fontFace: c.head, color: ink });
      if (s.subtitle) slide.addText(s.subtitle, { ...BODY, x: MARGIN, y: 5.4, w: MEASURE - 1, h: 0.9, fontSize: SIZE.body, fontFace: c.body, color: ink });
      break;
    case 'section':
      rule(slide, MARGIN, 2.9, 0.9, c.onPrimary, 0.08);
      slide.addText(s.title, { ...DISPLAY, x: MARGIN, y: 3.2, w: MEASURE + 1, h: 1.6, fontSize: SIZE.display + 8, fontFace: c.head, color: ink });
      if (s.subtitle) slide.addText(s.subtitle, { ...BODY, x: MARGIN, y: 5.0, w: MEASURE - 1, h: 0.9, fontSize: SIZE.small + 2, fontFace: c.body, color: ink });
      break;
    case 'bullets':
      heading(slide, s.title, c);
      slide.addText(bulletRuns(s.bullets, SIZE.body, c.text, c.body, 20), { ...BODY, x: MARGIN, y: BODY_Y, w: MEASURE, h: 3.4, lineSpacingMultiple: 1.15 });
      break;
    case 'two_column': {
      heading(slide, s.title, c);
      const colW = (CONTENT_W - GAP.l) / 2;
      [s.left, s.right].forEach((col, i) => {
        const x = MARGIN + i * (colW + GAP.l);
        rule(slide, x, BODY_Y, colW, c.border, 0.02);
        slide.addText(col.heading, { margin: 0, x, y: BODY_Y + GAP.s + 0.05, w: colW, h: 0.5, fontSize: SIZE.small, bold: true, color: c.primary, fontFace: c.head, valign: 'middle', charSpacing: 1 });
        slide.addText(bulletRuns(col.bullets, SIZE.small + 2, c.text, c.body, 14), { ...BODY, x, y: BODY_Y + 0.95, w: colW, h: 2.6 });
      });
      break;
    }
    case 'stat': {
      heading(slide, s.title, c);
      const n = s.stats.length;
      const colW = (CONTENT_W - GAP.l * (n - 1)) / n;
      s.stats.forEach((stat, i) => {
        const x = MARGIN + i * (colW + GAP.l);
        rule(slide, x, BODY_Y, colW, c.border, 0.02);
        slide.addText(stat.value, { ...DISPLAY, x, y: BODY_Y + GAP.s, w: colW, h: 1.7, fontSize: n === 1 ? 120 : SIZE.hero, fontFace: c.head, color: c.primary, valign: 'middle', charSpacing: -2 });
        slide.addText(stat.label, { ...BODY, x, y: BODY_Y + GAP.s + 1.85, w: Math.min(colW, 5.2), h: 1.0, fontSize: SIZE.small + 2, fontFace: c.body, color: c.muted });
      });
      break;
    }
    case 'quote':
      rule(slide, MARGIN, 2.0, 0.06, c.primary, 3.0);
      slide.addText(s.quote, { ...DISPLAY, bold: false, x: MARGIN + GAP.m, y: 2.0, w: MEASURE, h: 3.0, fontSize: SIZE.display - 4, fontFace: c.head, color: c.text, valign: 'middle' });
      if (s.attribution) slide.addText(s.attribution, { ...BODY, x: MARGIN + GAP.m, y: 5.3, w: MEASURE, h: 0.4, fontSize: SIZE.small, fontFace: c.body, color: c.muted, charSpacing: 1 });
      break;
    case 'table': {
      heading(slide, s.title, c);
      const none = { type: 'none' as const };
      const line = (color: string, pt: number) => ({ type: 'solid' as const, color, pt });
      const head = s.columns.map((col) => ({
        text: col,
        options: { bold: true, color: c.muted, fontSize: SIZE.caption + 2, fontFace: c.body, charSpacing: 1, border: [none, none, line(c.text, 1), none] },
      }));
      const rows = s.rows.map((r) =>
        r.map((cell, ci) => ({
          text: cell,
          options: { color: c.text, bold: ci === 0, fontSize: SIZE.small, fontFace: c.body, border: [none, none, line(c.border, 0.5), none] },
        })),
      );
      slide.addTable([head, ...rows], { x: MARGIN, y: BODY_Y, w: CONTENT_W, margin: [0.12, 0.1, 0.12, 0], valign: 'middle', rowH: 0.55 });
      break;
    }
    case 'closing':
      rule(slide, MARGIN, TOP, 0.6, c.primary, 0.06);
      slide.addText(s.title, { ...DISPLAY, x: MARGIN, y: TITLE_Y, w: MEASURE + 1, h: 1.6, fontSize: SIZE.display + 8, fontFace: c.head, color: c.text });
      if (s.bullets?.length) slide.addText(bulletRuns(s.bullets, SIZE.body, c.text, c.body, 20), { ...BODY, x: MARGIN, y: BODY_Y + 0.3, w: MEASURE, h: 3.0, lineSpacingMultiple: 1.15 });
      break;
  }

  if (s.layout !== 'title') footer(slide, index + 1, deck.slides.length, deck.title, bold ? c.onPrimary : c.muted, c);
  if (s.notes) slide.addNotes(s.notes);
}

export async function renderDeck(deck: DeckSpec, style: DeckStyle): Promise<Buffer> {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.title = deck.title;
  pptx.author = 'Riff';
  const colors = colorsOf(style);
  deck.slides.forEach((s, i) => drawSlide(pptx, deck, s, i, colors));
  return (await pptx.write({ outputType: 'nodebuffer' })) as Buffer;
}
