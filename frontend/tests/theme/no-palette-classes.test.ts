import { readdirSync, readFileSync } from 'fs';
import { join, relative } from 'path';

import { describe, expect, test } from 'bun:test';

/**
 * Every colour in the app comes from Riff's generated theme tokens, by way of
 * the CSS variables globals.css aliases and the Tailwind config's `themeColor`
 * helper (see tailwind-theme-colors.test.ts). A literal Tailwind palette class
 * — `bg-gray-100`, `text-blue-600`, `border-amber-200` — bypasses that
 * entirely, which is exactly how the purple-vs-blue button inconsistency the
 * consolidate-ui ticket fixed came about in the first place.
 *
 * This test is the regression guard: it walks frontend/src and fails if a
 * palette class comes back. When it fails, reach for the theme tokens instead
 * — background/foreground, muted, card, primary, secondary, accent,
 * destructive, success, warning, info, border-border.
 */

const SRC_DIR = join(import.meta.dir, '..', '..', 'src');

const EXTENSIONS = ['.ts', '.tsx', '.css'];

const SKIP_DIRS = new Set(['node_modules', '.next', 'dist']);

const PALETTE_CLASS =
  /-(gray|slate|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-[0-9]{2,3}/g;

/**
 * `bg-white` / `text-black` bypass the theme just as completely as a numbered
 * palette class does — a `bg-white` header stays white under a dark theme — so
 * they are caught too, with an optional alpha modifier (`bg-black/80`).
 */
const NEUTRAL_CLASS = /\b(?:bg|text|border|ring|fill|stroke|from|via|to)-(?:white|black)(?:\/[0-9]{1,3})?\b/g;

/**
 * The utilities each file is excused for naming in literal white/black, and
 * why. A file that is not listed here may not use them at all, and a listed
 * file may only use the exact utilities named. What they have in common:
 * every one is a scrim or hairline drawn *over arbitrary content*, where a
 * fixed translucent black or white is the intended effect under any theme —
 * not a surface that should follow the theme's background.
 */
const NEUTRAL_ALLOWLIST = new Map<string, string[]>([
  // Radix overlay scrims behind a modal dialog/sheet: a translucent veil over
  // whatever the page was showing, not a themed surface.
  ['components/ui/dialog.tsx', ['bg-black/80']],
  ['components/ui/sheet.tsx', ['bg-black/80']],
  // The drag-and-drop import overlay is the same kind of scrim, plus the text
  // on top of it, which has to stay legible against the veil rather than
  // against the theme's background.
  ['components/ImportAudio/ImportDropOverlay.tsx', ['bg-black/60', 'text-white', 'text-white/80']],
  // A ring around a swatch of *another* app's proposed theme colour in the
  // Dev Sessions theme picker: it separates the swatch from whatever
  // arbitrary colour sits behind it, so it cannot come from this app's theme.
  ['components/DevSessions/themes/ThemeTile.tsx', ['border-white']],
  // Hairline on a pill painted with a notebook's own cover colour (see the
  // lib/journal/format.ts entry below): it shades that arbitrary colour
  // slightly rather than drawing a themed border.
  ['components/MeetingDetails/MeetingJournalStrip.tsx', ['border-black/5']],
]);

/**
 * The only files allowed to name palette colours, because the colour is *data*
 * chosen per entity rather than app chrome — collapsing them onto the theme's
 * single primary hue would delete a real feature, not fix a bug. Keep this
 * list as short as it is; a new entry needs the same kind of justification.
 */
const ALLOWLIST = new Set([
  // Per-notebook cover colours on the journal shelf: picked per notebook and
  // stored in the database (NOTEBOOK_COLORS mirrors repository.rs) so the user
  // can tell notebooks apart at a glance. Everything rendered *around* a
  // swatch still uses theme tokens.
  'lib/journal/format.ts',
  // Per-engineer lane colours for the Dev Sessions coding team: each roster
  // member keeps one hue across the Plan and Coding tabs so the same face is
  // recognisable in both. Six distinguishable hues is the point, so there is
  // no single theme token that could replace them.
  'lib/dev-sessions/agents.ts',
]);

/**
 * The Dev Sessions theme-editing components (ThemeStudio, ThemeEditor,
 * ThemeAdoptionCard, ThemeProposalPanel) render *another* app's arbitrary
 * theme colours and are a documented carve-out from this rule, but they do it
 * with inline styles driven by the proposed theme's values rather than literal
 * palette classes — so they need no allowlist entry today. If one ever starts
 * matching, add it here with that reasoning rather than widening the regex.
 */

interface Violation {
  file: string;
  line: number;
  match: string;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return SKIP_DIRS.has(entry.name) ? [] : sourceFiles(path);
    }
    return EXTENSIONS.some((extension) => entry.name.endsWith(extension)) ? [path] : [];
  });
}

function matchesIn(path: string, pattern: RegExp = PALETTE_CLASS): Violation[] {
  const file = relative(SRC_DIR, path);

  return readFileSync(path, 'utf8')
    .split('\n')
    .flatMap((text, index) =>
      Array.from(text.matchAll(pattern), (match) => ({
        file,
        line: index + 1,
        match: match[0],
      })),
    );
}

function violationsIn(path: string): Violation[] {
  const file = relative(SRC_DIR, path);
  const excused = NEUTRAL_ALLOWLIST.get(file) ?? [];

  return [
    ...(ALLOWLIST.has(file) ? [] : matchesIn(path)),
    ...matchesIn(path, NEUTRAL_CLASS).filter(({ match }) => !excused.includes(match)),
  ];
}

describe('no literal Tailwind palette classes in frontend/src', () => {
  test('the tree only names colours through theme tokens', () => {
    const violations = sourceFiles(SRC_DIR).flatMap(violationsIn);

    const report = violations.map(({ file, line, match }) => `src/${file}:${line} — ${match}`);

    expect(report).toEqual([]);
  });

  test('the walk actually reaches the source tree', () => {
    // Guards the guard: a bad SRC_DIR would make the test above pass by
    // finding nothing at all.
    expect(sourceFiles(SRC_DIR).length).toBeGreaterThan(100);
  });

  test('a reintroduced palette class would be caught', () => {
    const reintroduced = 'className="bg-gray-100 text-blue-600"';

    expect(Array.from(reintroduced.matchAll(PALETTE_CLASS), (match) => match[0])).toEqual(['-gray-100', '-blue-600']);
  });

  test('every allowlisted file still contains the palette classes it was excused for', () => {
    // Proves the whole detector end-to-end against real files on disk — walk,
    // read, match, report — which is what would actually catch a regression,
    // rather than just the regex in isolation. It also keeps the allowlist
    // honest: if one of these files stops naming palette colours its entry is
    // dead, and should be deleted rather than left to excuse a future one.
    const stale = Array.from(ALLOWLIST).filter((file) => matchesIn(join(SRC_DIR, file)).length === 0);

    expect(stale).toEqual([]);
  });

  test('a reintroduced white or black utility would be caught', () => {
    const reintroduced = 'className="bg-white text-black/70"';

    expect(Array.from(reintroduced.matchAll(NEUTRAL_CLASS), (match) => match[0])).toEqual([
      'bg-white',
      'text-black/70',
    ]);
  });

  test('every file excused for white/black still uses exactly what it was excused for', () => {
    // Same honesty check as the palette allowlist above, in both directions:
    // an entry that no longer matches is dead and should be deleted, and an
    // excused utility that is no longer used should not stay excused.
    const stale = Array.from(NEUTRAL_ALLOWLIST).flatMap(([file, excused]) => {
      const used = new Set(matchesIn(join(SRC_DIR, file), NEUTRAL_CLASS).map(({ match }) => match));

      return excused.filter((utility) => !used.has(utility)).map((utility) => `src/${file} — ${utility}`);
    });

    expect(stale).toEqual([]);
  });

  test('theme token utilities are not mistaken for palette classes', () => {
    const themed = 'className="bg-muted text-primary-foreground border-border bg-primary/10 gap-2"';

    expect(Array.from(themed.matchAll(PALETTE_CLASS))).toEqual([]);
    expect(Array.from(themed.matchAll(NEUTRAL_CLASS))).toEqual([]);
  });
});
