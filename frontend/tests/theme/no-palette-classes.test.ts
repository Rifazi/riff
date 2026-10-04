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

function matchesIn(path: string): Violation[] {
  const file = relative(SRC_DIR, path);

  return readFileSync(path, 'utf8')
    .split('\n')
    .flatMap((text, index) =>
      Array.from(text.matchAll(PALETTE_CLASS), (match) => ({
        file,
        line: index + 1,
        match: match[0],
      })),
    );
}

function violationsIn(path: string): Violation[] {
  return ALLOWLIST.has(relative(SRC_DIR, path)) ? [] : matchesIn(path);
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

  test('theme token utilities are not mistaken for palette classes', () => {
    const themed = 'className="bg-muted text-primary-foreground border-border bg-primary/10 gap-2"';

    expect(Array.from(themed.matchAll(PALETTE_CLASS))).toEqual([]);
  });
});
