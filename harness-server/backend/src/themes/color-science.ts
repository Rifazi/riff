import type { ThemeColors, ThemeDefinition } from './presets.js';

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface Oklch {
  l: number;
  c: number;
  h: number;
}

/** #rgb, #rgba, #rrggbb, #rrggbbaa and rgb()/rgba() with literal numbers. Alpha is ignored. */
export function parseColor(input: string): Rgb | null {
  const text = input.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(text);
  if (hex) {
    let h = hex[1];
    if (h.length <= 4) h = [...h].map((c) => c + c).join('');
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
  }
  const fn = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(text);
  if (fn) {
    const [r, g, b] = [fn[1], fn[2], fn[3]].map(Number);
    if ([r, g, b].every((n) => n >= 0 && n <= 255)) return { r, g, b };
  }
  return null;
}

const toLinear = (channel: number): number => {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

export function relativeLuminance({ r, g, b }: Rgb): number {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** WCAG 2.x contrast ratio, 1 to 21. */
export function contrastRatio(fg: Rgb, bg: Rgb): number {
  const a = relativeLuminance(fg);
  const b = relativeLuminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export function toOklch({ r, g, b }: Rgb): Oklch {
  const [lr, lg, lb] = [toLinear(r), toLinear(g), toLinear(b)];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const c = Math.hypot(A, B);
  const h = ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360;
  return { l: L, c, h: c < 0.002 ? 0 : h };
}

const hueDistance = (a: number, b: number): number => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

/** Below this chroma a color reads as a neutral, whatever its hue. */
export const NEUTRAL_CHROMA = 0.04;

export type Harmony = 'monochromatic' | 'analogous' | 'complementary' | 'split-complementary' | 'triadic' | 'tetradic' | 'scattered' | 'neutral';

export interface PaletteReading {
  harmony: Harmony;
  /** Hues (degrees) of the chromatic colors, one per color family. */
  hues: number[];
  notes: string[];
}

/** Groups hues that sit within 25° of each other into one family and returns each family's mean hue. */
function hueFamilies(hues: number[]): number[] {
  const families: number[][] = [];
  for (const h of [...hues].sort((a, b) => a - b)) {
    const family = families.find((f) => hueDistance(f[0], h) <= 25);
    if (family) family.push(h);
    else families.push([h]);
  }
  if (families.length > 1 && hueDistance(families[0][0], families[families.length - 1][0]) <= 25) {
    families[0].push(...(families.pop() as number[]));
  }
  return families.map((f) => {
    const x = f.reduce((s, h) => s + Math.cos((h * Math.PI) / 180), 0);
    const y = f.reduce((s, h) => s + Math.sin((h * Math.PI) / 180), 0);
    return Math.round(((Math.atan2(y, x) * 180) / Math.PI + 360) % 360);
  });
}

/** Names the color harmony a set of colors forms and flags the usual palette faults. */
export function readPalette(colors: Rgb[]): PaletteReading {
  const lch = colors.map(toOklch);
  const chromatic = lch.filter((c) => c.c >= NEUTRAL_CHROMA);
  const notes: string[] = [];
  if (chromatic.length === 0) return { harmony: 'neutral', hues: [], notes: ['No chromatic color: the palette is neutral, so hierarchy has to come from lightness and weight alone.'] };

  const hues = hueFamilies(chromatic.map((c) => c.h));
  let harmony: Harmony;
  if (hues.length === 1) harmony = 'monochromatic';
  else {
    const spread = Math.max(...hues.flatMap((a) => hues.map((b) => hueDistance(a, b))));
    if (hues.length === 2) harmony = spread <= 70 ? 'analogous' : spread >= 150 ? 'complementary' : 'scattered';
    else if (hues.length === 3) {
      const gaps = hues
        .map((h, i) => hueDistance(h, hues[(i + 1) % 3]))
        .sort((a, b) => a - b);
      if (spread <= 80) harmony = 'analogous';
      else if (gaps[0] >= 100 && gaps[2] <= 140) harmony = 'triadic';
      else if (hues.some((h) => hues.filter((o) => hueDistance(h, o) >= 140).length === 2)) harmony = 'split-complementary';
      else harmony = 'scattered';
    } else harmony = hues.length === 4 ? 'tetradic' : 'scattered';
  }
  if (hues.length >= 5) notes.push(`${hues.length} unrelated hue families: too many for a UI palette, which usually reads as noisy. Keep one brand hue, one accent, and status colors.`);
  const loud = chromatic.filter((c) => c.c > 0.26);
  if (loud.length > 0) notes.push(`${loud.length} color(s) with chroma above 0.26 (near the edge of the screen's gamut): saturated fills at that level vibrate next to each other and tire the eye. Use them for small accents only.`);
  const mids = chromatic.filter((c) => c.l > 0.55 && c.l < 0.75 && c.c > 0.15);
  if (mids.length >= 3) notes.push('Three or more strong colors with the same mid lightness compete for attention; vary their lightness so one leads.');
  return { harmony, hues, notes };
}

export interface ContrastVerdict {
  ratio: number;
  level: 'AAA' | 'AA' | 'AA-large' | 'fail';
}

export function contrastVerdict(ratio: number): ContrastVerdict['level'] {
  if (ratio >= 7) return 'AAA';
  if (ratio >= 4.5) return 'AA';
  if (ratio >= 3) return 'AA-large';
  return 'fail';
}

interface PairCheck {
  label: string;
  fg: keyof ThemeColors;
  bg: keyof ThemeColors;
  // Minimum ratio this pair needs where it's used.
  min: number;
  why: string;
}

const THEME_PAIRS: PairCheck[] = [
  { label: 'text on page', fg: 'text', bg: 'bg', min: 4.5, why: 'body text' },
  { label: 'text on surface', fg: 'text', bg: 'surface', min: 4.5, why: 'card text' },
  { label: 'text on muted surface', fg: 'text', bg: 'surfaceMuted', min: 4.5, why: 'table rows, inputs' },
  { label: 'muted text on page', fg: 'textMuted', bg: 'bg', min: 4.5, why: 'captions, help text' },
  { label: 'muted text on surface', fg: 'textMuted', bg: 'surface', min: 4.5, why: 'captions in cards' },
  { label: 'primary-button label', fg: 'onPrimary', bg: 'primary', min: 4.5, why: 'text on the main button' },
  { label: 'primary as link text', fg: 'primary', bg: 'surface', min: 4.5, why: 'links' },
  { label: 'primary against page (non-text)', fg: 'primary', bg: 'bg', min: 3, why: 'icons, focus rings, active states' },
  { label: 'border against page (non-text)', fg: 'border', bg: 'bg', min: 1.15, why: 'a divider that can be seen at all; input borders need 3' },
  { label: 'danger against surface', fg: 'danger', bg: 'surface', min: 3, why: 'error text and icons (4.5 if text)' },
  { label: 'success against surface', fg: 'success', bg: 'surface', min: 3, why: 'status icons and badges' },
  { label: 'warning against surface', fg: 'warning', bg: 'surface', min: 3, why: 'status icons and badges' },
];

const fmt = (n: number): string => n.toFixed(2);

function analyzeMode(mode: 'light' | 'dark', colors: ThemeColors): string[] {
  const lines: string[] = [`## ${mode} mode`, '', '| pair | ratio | needs | result |', '|---|---|---|---|'];
  const problems: string[] = [];
  for (const pair of THEME_PAIRS) {
    const fg = parseColor(colors[pair.fg]);
    const bg = parseColor(colors[pair.bg]);
    if (!fg || !bg) {
      lines.push(`| ${pair.label} | ? | ${pair.min} | unreadable color |`);
      continue;
    }
    const ratio = contrastRatio(fg, bg);
    const ok = ratio >= pair.min;
    lines.push(`| ${pair.label} (${pair.why}) | ${fmt(ratio)} | ${pair.min} | ${ok ? 'ok' : 'FAIL'} |`);
    if (!ok) problems.push(`${pair.label}: ${fmt(ratio)}:1, needs ${pair.min}:1`);
  }
  const bg = parseColor(colors.bg);
  const surface = parseColor(colors.surface);
  if (bg && surface && contrastRatio(bg, surface) < 1.02) {
    problems.push('page and surface are almost the same color: cards need a border or a shadow to separate from the page');
  }
  const text = parseColor(colors.text);
  if (text && bg) {
    const lightness = toOklch(text).l - toOklch(bg).l;
    if (Math.abs(lightness) > 0.2 && contrastRatio(text, bg) > 17) {
      problems.push('text on page is near pure black on white (or the reverse): the extreme contrast causes glare; soften it slightly');
    }
  }
  const chrome = [colors.primary, colors.success, colors.warning, colors.danger, colors.info].map(parseColor).filter((c): c is Rgb => c !== null);
  const reading = readPalette(chrome);
  lines.push('', `Brand and status colors form a ${reading.harmony} palette (hue families: ${reading.hues.join('°, ') || 'none'}°).`);
  for (const note of reading.notes) problems.push(note);
  lines.push('', problems.length ? 'Problems:' : 'No problems found.', ...problems.map((p) => `- ${p}`));
  return lines;
}

/** Every contrast pair and palette check on both modes of an app's theme, as markdown. */
export function analyzeThemeColors(theme: ThemeDefinition): string {
  return [`# Colors of "${theme.name}"`, '', ...analyzeMode('light', theme.light), '', ...analyzeMode('dark', theme.dark)].join('\n');
}

export interface PairInput {
  fg: string;
  bg: string;
  label?: string;
  /** Large text (24px, or 19px bold) and UI components need only 3:1. */
  large?: boolean;
}

export function analyzePairs(pairs: PairInput[]): string {
  return pairs
    .map((p) => {
      const fg = parseColor(p.fg);
      const bg = parseColor(p.bg);
      const name = p.label ?? `${p.fg} on ${p.bg}`;
      if (!fg || !bg) return `${name}: could not read the color (use #hex or rgb(r, g, b))`;
      const ratio = contrastRatio(fg, bg);
      const need = p.large ? 3 : 4.5;
      return `${name}: ${fmt(ratio)}:1 (${contrastVerdict(ratio)}), ${ratio >= need ? 'passes' : `FAILS, needs ${need}:1`}`;
    })
    .join('\n');
}

export function analyzePalette(colors: string[]): string {
  const parsed = colors.map((c) => ({ text: c, rgb: parseColor(c) }));
  const valid = parsed.filter((p): p is { text: string; rgb: Rgb } => p.rgb !== null);
  const unreadable = parsed.filter((p) => p.rgb === null).map((p) => p.text);
  const reading = readPalette(valid.map((p) => p.rgb));
  const rows = valid.map((p) => {
    const { l, c, h } = toOklch(p.rgb);
    return `- ${p.text}: lightness ${l.toFixed(2)}, chroma ${c.toFixed(2)}, hue ${Math.round(h)}°${c < NEUTRAL_CHROMA ? ' (neutral)' : ''}`;
  });
  return [
    `Harmony: ${reading.harmony}; hue families at ${reading.hues.join('°, ') || 'none'}°.`,
    ...rows,
    ...reading.notes.map((n) => `Note: ${n}`),
    ...(unreadable.length ? [`Could not read: ${unreadable.join(', ')}`] : []),
  ].join('\n');
}
