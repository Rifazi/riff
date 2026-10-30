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
const MARGIN = 0.9;
const CONTENT_W = W - MARGIN * 2;

// pptxgenjs wants hex without the "#".
const hex = (color: string) => color.replace('#', '').toUpperCase();

interface Colors {
  bg: string;
  surface: string;
  surfaceMuted: string;
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
  surfaceMuted: hex(s.surfaceMuted),
  border: hex(s.border),
  text: hex(s.text),
  muted: hex(s.textMuted),
  primary: hex(s.primary),
  onPrimary: hex(s.onPrimary),
  head: s.headingFont,
  body: s.bodyFont,
});

const bulletRuns = (items: string[], size: number, c: Colors): TextRun[] =>
  items.map((text, i) => ({
    text,
    options: { bullet: { indent: 20 }, breakLine: i < items.length - 1, fontSize: size, color: c.text, fontFace: c.body, paraSpaceAfter: 10 },
  }));

const rule = (slide: PptxSlide, x: number, y: number, c: Colors) =>
  slide.addShape('rect', { x, y, w: 1.2, h: 0.08, fill: { color: c.primary }, line: { color: c.primary, width: 0 } });

// Every slide has the same band down its left edge; the opening, divider and
// closing slides just make it wider, so the deck reads as one look.
function band(slide: PptxSlide, c: Colors, wide: boolean) {
  slide.addShape('rect', { x: 0, y: 0, w: wide ? 0.55 : 0.18, h: H, fill: { color: c.primary }, line: { color: c.primary, width: 0 } });
}

function heading(slide: PptxSlide, title: string, c: Colors) {
  band(slide, c, false);
  slide.addText(title, { x: MARGIN, y: 0.45, w: CONTENT_W, h: 0.9, fontSize: 30, bold: true, fontFace: c.head, color: c.text, valign: 'middle', fit: 'shrink' });
}

function footer(slide: PptxSlide, index: number, total: number, deckTitle: string, c: Colors) {
  slide.addText(deckTitle, { x: MARGIN, y: H - 0.5, w: 8, h: 0.3, fontSize: 10, color: c.muted, fontFace: c.body });
  slide.addText(`${index} / ${total}`, { x: W - MARGIN - 1.5, y: H - 0.5, w: 1.5, h: 0.3, fontSize: 10, color: c.muted, align: 'right', fontFace: c.body });
}

function drawSlide(pptx: Pptx, deck: DeckSpec, s: Slide, index: number, c: Colors) {
  const slide = pptx.addSlide();
  slide.background = { color: c.bg };

  switch (s.layout) {
    case 'title':
      band(slide, c, true);
      rule(slide, MARGIN + 0.3, 2.55, c);
      slide.addText(s.title, { x: MARGIN + 0.3, y: 2.8, w: CONTENT_W - 0.3, h: 1.7, fontSize: 44, bold: true, color: c.text, fontFace: c.head, valign: 'top', fit: 'shrink' });
      if (s.subtitle) slide.addText(s.subtitle, { x: MARGIN + 0.3, y: 4.6, w: CONTENT_W - 0.3, h: 0.9, fontSize: 20, color: c.muted, fontFace: c.body, valign: 'top', fit: 'shrink' });
      break;
    case 'section':
      band(slide, c, true);
      slide.addText(s.title, { x: MARGIN + 0.3, y: 2.7, w: CONTENT_W - 0.3, h: 1.3, fontSize: 38, bold: true, color: c.text, fontFace: c.head, valign: 'bottom', fit: 'shrink' });
      rule(slide, MARGIN + 0.3, 4.15, c);
      if (s.subtitle) slide.addText(s.subtitle, { x: MARGIN + 0.3, y: 4.4, w: CONTENT_W - 0.3, h: 0.9, fontSize: 18, color: c.muted, fontFace: c.body, valign: 'top', fit: 'shrink' });
      break;
    case 'bullets':
      heading(slide, s.title, c);
      slide.addText(bulletRuns(s.bullets, 22, c), { x: MARGIN, y: 1.6, w: CONTENT_W, h: 4.8, valign: 'top', fit: 'shrink' });
      break;
    case 'two_column': {
      heading(slide, s.title, c);
      const colW = (CONTENT_W - 0.5) / 2;
      [s.left, s.right].forEach((col, i) => {
        const x = MARGIN + i * (colW + 0.5);
        slide.addShape('roundRect', { x, y: 1.6, w: colW, h: 4.8, rectRadius: 0.1, fill: { color: c.surface }, line: { color: c.border, width: 1.5 } });
        slide.addText(col.heading, { x: x + 0.3, y: 1.75, w: colW - 0.6, h: 0.6, fontSize: 20, bold: true, color: c.primary, fontFace: c.head, valign: 'middle' });
        slide.addText(bulletRuns(col.bullets, 18, c), { x: x + 0.3, y: 2.45, w: colW - 0.6, h: 3.8, valign: 'top', fit: 'shrink' });
      });
      break;
    }
    case 'stat': {
      heading(slide, s.title, c);
      const n = s.stats.length;
      const gap = 0.4;
      const cardW = (CONTENT_W - gap * (n - 1)) / n;
      s.stats.forEach((stat, i) => {
        const x = MARGIN + i * (cardW + gap);
        slide.addShape('roundRect', { x, y: 1.9, w: cardW, h: 3.8, rectRadius: 0.1, fill: { color: c.surfaceMuted }, line: { color: c.border, width: 1 } });
        slide.addText(stat.value, { x, y: 2.3, w: cardW, h: 1.7, fontSize: 60, bold: true, color: c.primary, align: 'center', valign: 'middle', fontFace: c.head, fit: 'shrink' });
        slide.addText(stat.label, { x: x + 0.3, y: 4.1, w: cardW - 0.6, h: 1.3, fontSize: 18, color: c.text, align: 'center', valign: 'top', fontFace: c.body, fit: 'shrink' });
      });
      break;
    }
    case 'quote':
      band(slide, c, false);
      slide.addText('“', { x: MARGIN, y: 1.2, w: 2, h: 1.6, fontSize: 120, color: c.primary, fontFace: c.head });
      slide.addText(s.quote, { x: MARGIN + 0.3, y: 2.6, w: CONTENT_W - 0.6, h: 2.6, fontSize: 30, italic: true, color: c.text, fontFace: c.head, valign: 'middle', fit: 'shrink' });
      if (s.attribution) slide.addText(`— ${s.attribution}`, { x: MARGIN + 0.3, y: 5.4, w: CONTENT_W - 0.6, h: 0.5, fontSize: 16, color: c.muted, fontFace: c.body });
      break;
    case 'table': {
      heading(slide, s.title, c);
      const head = s.columns.map((col) => ({ text: col, options: { bold: true, color: c.onPrimary, fill: { color: c.primary }, fontSize: 16, fontFace: c.head } }));
      const rows = s.rows.map((r, ri) =>
        r.map((cell) => ({ text: cell, options: { color: c.text, fill: { color: ri % 2 ? c.surfaceMuted : c.surface }, fontSize: 15, fontFace: c.body } })),
      );
      slide.addTable([head, ...rows], { x: MARGIN, y: 1.7, w: CONTENT_W, border: { type: 'solid', color: c.border, pt: 0.75 }, margin: 0.12, valign: 'middle' });
      break;
    }
    case 'closing':
      band(slide, c, true);
      slide.addText(s.title, { x: MARGIN + 0.3, y: 1.2, w: CONTENT_W - 0.3, h: 1.3, fontSize: 40, bold: true, color: c.text, fontFace: c.head, valign: 'middle', fit: 'shrink' });
      rule(slide, MARGIN + 0.3, 2.6, c);
      if (s.bullets?.length) slide.addText(bulletRuns(s.bullets, 22, c), { x: MARGIN + 0.3, y: 3.0, w: CONTENT_W - 0.3, h: 3.4, valign: 'top', fit: 'shrink' });
      break;
  }

  if (s.layout !== 'title') footer(slide, index + 1, deck.slides.length, deck.title, c);
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
