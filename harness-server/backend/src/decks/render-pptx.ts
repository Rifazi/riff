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
function heading(slide: PptxSlide, title: string, c: Colors, dy: number) {
  rule(slide, MARGIN, TOP + dy, 0.6, c.primary, 0.06);
  slide.addText(title, { ...DISPLAY, x: MARGIN, y: TITLE_Y + dy, w: MEASURE + 1, h: 1.4, fontSize: SIZE.title, fontFace: c.head, color: c.text });
}

// Content slides are centered vertically between the top margin and the footer
// instead of hanging from the top. Text has no measured height here, so the
// block's height is estimated from how many lines each string wraps to.
const AREA_TOP = TOP;
const AREA_BOTTOM = FOOT_Y - 0.3;
const lines = (text: string, size: number, widthIn: number) => Math.max(1, Math.ceil(text.length / ((widthIn * 72) / (size * 0.5))));
const bulletsH = (items: string[], size: number, widthIn: number, after: number) =>
  items.reduce((h, t) => h + (lines(t, size, widthIn - 0.4) * size * 1.2 * 1.15 + after) / 72, 0);
/** Offset that centers a block of `bodyH` inches starting at BODY_Y, under the heading, in the content area. */
function centerDy(bodyH: number, hasHeading = true) {
  const blockH = (hasHeading ? BODY_Y - AREA_TOP : 0) + bodyH;
  return Math.max(0, Math.min((AREA_BOTTOM - AREA_TOP - blockH) / 2, 1.2));
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

  let dy = 0;
  switch (s.layout) {
    case 'bullets': dy = centerDy(bulletsH(s.bullets, SIZE.body, MEASURE, 20)); break;
    case 'two_column':
      dy = centerDy(0.95 + Math.max(...[s.left, s.right].map((col) => bulletsH(col.bullets, SIZE.small + 2, (CONTENT_W - GAP.l) / 2, 14))));
      break;
    case 'stat': dy = centerDy(GAP.s + 1.85 + 1.0); break;
    case 'table': dy = centerDy((s.rows.length + 1) * 0.55); break;
    case 'timeline': dy = centerDy(1.9); break;
    case 'process': dy = centerDy(2.2); break;
    case 'bar_chart': dy = centerDy(s.items.length * 0.65 + (s.caption ? 0.6 : 0)); break;
    case 'status_list': dy = centerDy(s.items.length * 0.75); break;
    case 'closing': dy = centerDy(s.bullets?.length ? 0.3 + bulletsH(s.bullets, SIZE.body, MEASURE, 20) : 0); break;
  }

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
      heading(slide, s.title, c, dy);
      slide.addText(bulletRuns(s.bullets, SIZE.body, c.text, c.body, 20), { ...BODY, x: MARGIN, y: BODY_Y + dy, w: MEASURE, h: 3.4, lineSpacingMultiple: 1.15 });
      break;
    case 'two_column': {
      heading(slide, s.title, c, dy);
      const colW = (CONTENT_W - GAP.l) / 2;
      [s.left, s.right].forEach((col, i) => {
        const x = MARGIN + i * (colW + GAP.l);
        rule(slide, x, BODY_Y + dy, colW, c.border, 0.02);
        slide.addText(col.heading, { margin: 0, x, y: BODY_Y + dy + GAP.s + 0.05, w: colW, h: 0.5, fontSize: SIZE.small, bold: true, color: c.primary, fontFace: c.head, valign: 'middle', charSpacing: 1 });
        slide.addText(bulletRuns(col.bullets, SIZE.small + 2, c.text, c.body, 14), { ...BODY, x, y: BODY_Y + dy + 0.95, w: colW, h: 2.6 });
      });
      break;
    }
    case 'stat': {
      heading(slide, s.title, c, dy);
      const n = s.stats.length;
      const colW = (CONTENT_W - GAP.l * (n - 1)) / n;
      s.stats.forEach((stat, i) => {
        const x = MARGIN + i * (colW + GAP.l);
        rule(slide, x, BODY_Y + dy, colW, c.border, 0.02);
        slide.addText(stat.value, { ...DISPLAY, x, y: BODY_Y + dy + GAP.s, w: colW, h: 1.7, fontSize: n === 1 ? 120 : SIZE.hero, fontFace: c.head, color: c.primary, valign: 'middle', charSpacing: -2 });
        slide.addText(stat.label, { ...BODY, x, y: BODY_Y + dy + GAP.s + 1.85, w: Math.min(colW, 5.2), h: 1.0, fontSize: SIZE.small + 2, fontFace: c.body, color: c.muted });
      });
      break;
    }
    case 'quote':
      rule(slide, MARGIN, 2.0, 0.06, c.primary, 3.0);
      slide.addText(s.quote, { ...DISPLAY, bold: false, x: MARGIN + GAP.m, y: 2.0, w: MEASURE, h: 3.0, fontSize: SIZE.display - 4, fontFace: c.head, color: c.text, valign: 'middle' });
      if (s.attribution) slide.addText(s.attribution, { ...BODY, x: MARGIN + GAP.m, y: 5.3, w: MEASURE, h: 0.4, fontSize: SIZE.small, fontFace: c.body, color: c.muted, charSpacing: 1 });
      break;
    case 'statement': {
      const size = s.statement.length > 70 ? SIZE.display - 4 : SIZE.display + 8;
      rule(slide, MARGIN, 2.3, 0.6, c.primary, 0.06);
      slide.addText(s.statement, { ...DISPLAY, x: MARGIN, y: 2.6, w: MEASURE, h: 2.6, fontSize: size, fontFace: c.head, color: c.text, valign: 'top' });
      if (s.subtitle) slide.addText(s.subtitle, { ...BODY, x: MARGIN, y: 5.3, w: MEASURE - 1, h: 0.6, fontSize: SIZE.small, fontFace: c.body, color: c.muted });
      break;
    }
    case 'timeline': {
      heading(slide, s.title, c, dy);
      const n = s.events.length;
      const colW = CONTENT_W / n;
      const lineY = BODY_Y + dy + 0.15;
      rule(slide, MARGIN, lineY, CONTENT_W, c.border, 0.03);
      s.events.forEach((ev, i) => {
        const x = MARGIN + i * colW;
        slide.addShape('ellipse', { x, y: lineY - 0.125, w: 0.26, h: 0.26, fill: { color: i === n - 1 ? c.primary : c.bg }, line: { color: c.primary, width: 2 } });
        slide.addText(ev.when, { margin: 0, x, y: lineY + 0.45, w: colW - GAP.s, h: 0.4, fontSize: SIZE.small, bold: true, color: c.primary, fontFace: c.head, valign: 'top', charSpacing: 1 });
        slide.addText(ev.label, { ...BODY, x, y: lineY + 0.95, w: colW - GAP.m, h: 1.4, fontSize: SIZE.small + 2, fontFace: c.body, color: c.text });
      });
      break;
    }
    case 'process': {
      heading(slide, s.title, c, dy);
      const n = s.steps.length;
      const colW = (CONTENT_W - GAP.l * (n - 1)) / n;
      s.steps.forEach((step, i) => {
        const x = MARGIN + i * (colW + GAP.l);
        rule(slide, x, BODY_Y + dy, colW, c.border, 0.02);
        slide.addText(String(i + 1).padStart(2, '0'), { ...DISPLAY, x, y: BODY_Y + dy + GAP.s, w: colW, h: 0.9, fontSize: SIZE.display, fontFace: c.head, color: c.primary, valign: 'middle' });
        slide.addText(step.title, { ...DISPLAY, bold: true, x, y: BODY_Y + dy + 1.2, w: colW, h: 0.6, fontSize: SIZE.body, fontFace: c.head, color: c.text, charSpacing: 0 });
        if (step.detail) slide.addText(step.detail, { ...BODY, x, y: BODY_Y + dy + 1.85, w: colW, h: 1.0, fontSize: SIZE.small, fontFace: c.body, color: c.muted });
      });
      break;
    }
    case 'bar_chart': {
      heading(slide, s.title, c, dy);
      const max = Math.max(...s.items.map((it) => it.value), 1);
      const top = s.highlight ?? s.items.findIndex((it) => it.value === Math.max(...s.items.map((x) => x.value)));
      const labelW = 3.4;
      const trackW = CONTENT_W - labelW - 1.8;
      s.items.forEach((it, i) => {
        const y = BODY_Y + dy + i * 0.65;
        const on = i === top;
        slide.addText(it.label, { margin: 0, x: MARGIN, y, w: labelW - GAP.s, h: 0.45, fontSize: SIZE.small, fontFace: c.body, color: on ? c.text : c.muted, bold: on, valign: 'middle' });
        const w = Math.max(0.05, (it.value / max) * trackW);
        slide.addShape('rect', { x: MARGIN + labelW, y: y + 0.06, w, h: 0.33, fill: on ? { color: c.primary } : { color: c.muted, transparency: 70 }, line: { color: on ? c.primary : c.muted, width: 0, transparency: 100 } });
        slide.addText(it.display ?? String(it.value), { margin: 0, x: MARGIN + labelW + w + 0.15, y, w: 1.6, h: 0.45, fontSize: SIZE.small, bold: true, fontFace: c.head, color: on ? c.primary : c.text, valign: 'middle' });
      });
      if (s.caption) slide.addText(s.caption, { ...BODY, x: MARGIN, y: BODY_Y + dy + s.items.length * 0.65 + 0.15, w: MEASURE, h: 0.4, fontSize: SIZE.caption + 2, fontFace: c.body, color: c.muted });
      break;
    }
    case 'status_list': {
      heading(slide, s.title, c, dy);
      const words = { done: 'Done', open: 'Open', risk: 'At risk' } as const;
      s.items.forEach((it, i) => {
        const y = BODY_Y + dy + i * 0.75;
        rule(slide, MARGIN, y, CONTENT_W, c.border, 0.01);
        const filled = it.status !== 'open';
        slide.addShape('ellipse', { x: MARGIN, y: y + 0.2, w: 0.24, h: 0.24, fill: { color: filled ? (it.status === 'risk' ? c.text : c.primary) : c.bg }, line: { color: it.status === 'risk' ? c.text : c.primary, width: 2 } });
        slide.addText(it.label, { margin: 0, x: MARGIN + 0.55, y: y + 0.1, w: MEASURE, h: 0.45, fontSize: SIZE.body - 2, fontFace: c.body, color: c.text, valign: 'middle' });
        slide.addText(words[it.status], { margin: 0, x: W - MARGIN - 1.6, y: y + 0.1, w: 1.6, h: 0.45, fontSize: SIZE.caption + 2, bold: true, charSpacing: 1, align: 'right', fontFace: c.body, color: it.status === 'done' ? c.primary : c.muted, valign: 'middle' });
      });
      break;
    }
    case 'table': {
      heading(slide, s.title, c, dy);
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
      slide.addTable([head, ...rows], { x: MARGIN, y: BODY_Y + dy, w: CONTENT_W, margin: [0.12, 0.1, 0.12, 0], valign: 'middle', rowH: 0.55 });
      break;
    }
    case 'closing':
      rule(slide, MARGIN, TOP + dy, 0.6, c.primary, 0.06);
      slide.addText(s.title, { ...DISPLAY, x: MARGIN, y: TITLE_Y + dy, w: MEASURE + 1, h: 1.6, fontSize: SIZE.display + 8, fontFace: c.head, color: c.text });
      if (s.bullets?.length) slide.addText(bulletRuns(s.bullets, SIZE.body, c.text, c.body, 20), { ...BODY, x: MARGIN, y: BODY_Y + dy + 0.3, w: MEASURE, h: 3.0, lineSpacingMultiple: 1.15 });
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
