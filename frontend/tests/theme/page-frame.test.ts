import { readdirSync, readFileSync } from 'fs';
import { join, relative } from 'path';

import { describe, expect, test } from 'bun:test';

/**
 * Every top-level screen sits in the same frame — `Page`, `PageHeader` and
 * `PageBody` from components/ui/page.tsx — so every module has the same page
 * background and the same title bar. Before that frame existed, Dev Sessions
 * and meeting details sat on `bg-muted` while meetings, journals and settings
 * sat on `bg-background`, and each had its own copy of the header at its own
 * size and padding.
 *
 * This test is the regression guard: it fails if a file other than the frame
 * paints its own full-height page background, or renders its own page title.
 */

const SRC_DIR = join(import.meta.dir, '..', '..', 'src');

const FRAME = 'components/ui/page.tsx';

const SKIP_DIRS = new Set(['node_modules', '.next', 'dist']);

/** A class string for a full-height container that also sets a background: a page root. */
const PAGE_ROOT = /["'`](?=[^"'`]*\bh-screen\b)(?=[^"'`]*\bbg-)[^"'`]*["'`]/g;

const H1 = /<h1(?=[\s>]|$)/g;

/**
 * The files allowed an `<h1>` of their own, and why. None of them is a page
 * title bar.
 */
const H1_ALLOWLIST = new Map<string, string>([
  // Editable section headings inside a meeting summary document.
  ['components/EditableTitle.tsx', 'summary section heading'],
  // The app name inside the About dialog.
  ['components/About.tsx', 'dialog heading'],
  // Full-screen onboarding, shown before the app's sidebar and pages exist.
  ['components/onboarding/OnboardingContainer.tsx', 'onboarding step heading'],
  // Inside a generated HTML string for the note's markdown body, not JSX.
  ['app/notes/[id]/page.tsx', 'markdown body heading'],
]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return SKIP_DIRS.has(entry.name) ? [] : sourceFiles(path);
    }
    return entry.name.endsWith('.tsx') ? [path] : [];
  });
}

function matchesIn(path: string, pattern: RegExp): string[] {
  const file = relative(SRC_DIR, path);

  return readFileSync(path, 'utf8')
    .split('\n')
    .flatMap((text, index) => Array.from(text.matchAll(pattern), () => `src/${file}:${index + 1}`));
}

describe('every screen uses the central page frame', () => {
  test('no file but the frame paints its own page background', () => {
    const violations = sourceFiles(SRC_DIR)
      .filter((path) => relative(SRC_DIR, path) !== FRAME)
      .flatMap((path) => matchesIn(path, PAGE_ROOT));

    expect(violations).toEqual([]);
  });

  test('no file but the frame renders a page title', () => {
    const violations = sourceFiles(SRC_DIR)
      .filter((path) => {
        const file = relative(SRC_DIR, path);
        return file !== FRAME && !H1_ALLOWLIST.has(file);
      })
      .flatMap((path) => matchesIn(path, H1));

    expect(violations).toEqual([]);
  });

  test('every route page renders inside the frame', () => {
    // A route either composes the frame itself or hands off to a component
    // that does (PageShell for Dev Sessions, PageContent for meeting details).
    const FRAME_USERS = /from '@\/components\/ui\/page'|from "@\/components\/ui\/page"|PageShell|PageContent/;
    const routes = sourceFiles(join(SRC_DIR, 'app')).filter((path) => path.endsWith('/page.tsx'));

    const outside = routes
      .filter((path) => !FRAME_USERS.test(readFileSync(path, 'utf8')))
      .map((path) => `src/${relative(SRC_DIR, path)}`);

    expect(routes.length).toBeGreaterThan(5);
    expect(outside).toEqual([]);
  });

  test('the frame itself is what the detectors look for', () => {
    // Guards the guard: if the frame stopped matching, the tests above would
    // pass vacuously against a regex that no longer finds page roots.
    expect(matchesIn(join(SRC_DIR, FRAME), PAGE_ROOT).length).toBeGreaterThan(0);
    expect(matchesIn(join(SRC_DIR, FRAME), H1).length).toBe(1);
  });

  test('every file excused for an <h1> still has one', () => {
    const stale = Array.from(H1_ALLOWLIST.keys()).filter((file) => matchesIn(join(SRC_DIR, file), H1).length === 0);

    expect(stale).toEqual([]);
  });
});
