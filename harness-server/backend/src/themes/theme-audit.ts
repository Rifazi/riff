import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { summarizeAppTheme } from './apply-theme.js';
import { THEME_DIR } from './theme-docs.js';
import { tokenNames } from './theme-css.js';

const execFileAsync = promisify(execFile);

// How far an app's code has adopted its Riff theme: whether theme/index.css
// is wired in, and what still styles itself outside the theme (hard-coded
// colors, the app's own token definitions, Tailwind config, component
// libraries). Read-only. Shared by the audit_theme tool (so plan, coding
// and QA agents work from the same facts) and the Theme page.

const STYLE_EXTENSIONS = new Set([
  '.css', '.scss', '.sass', '.less', '.styl', '.pcss',
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.vue', '.svelte', '.astro', '.html',
]);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt', '.svelte-kit', 'vendor', THEME_DIR]);
const MAX_FILE_BYTES = 400_000;
const MAX_FILES = 4000;

// A color literal: #rgb/#rgba/#rrggbb/#rrggbbaa after a CSS/JS-ish
// delimiter (so "#add" in an href or a "#1" ticket ref mostly doesn't
// count), or an rgb()/hsl() call with literal numbers.
const HEX = /(?:^|[\s:'"`(,=])#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})\b/i;
const FUNC = /\b(?:rgba?|hsla?)\(\s*[\d.]/i;
const TOKEN_DEF = /(^|[\s{;])(--[a-z][\w-]*)\s*:/gi;

const COMPONENT_LIBRARIES: [string, string][] = [
  ['@mui/material', 'MUI'],
  ['@chakra-ui/react', 'Chakra UI'],
  ['antd', 'Ant Design'],
  ['@mantine/core', 'Mantine'],
  ['bootstrap', 'Bootstrap'],
  ['react-bootstrap', 'React Bootstrap'],
  ['vuetify', 'Vuetify'],
  ['@radix-ui/themes', 'Radix Themes'],
  ['styled-components', 'styled-components'],
  ['@emotion/react', 'Emotion'],
  ['class-variance-authority', 'shadcn/ui-style components (cva)'],
];

export interface ThemeAudit {
  theme: { name: string; inSync: boolean } | null;
  // Files that import theme/index.css (should be exactly one root entry).
  importedFrom: string[];
  hardCoded: { total: number; byFile: { file: string; count: number; samples: { line: number; text: string }[] }[] };
  // The app's own design tokens, defined outside theme/ — candidates to
  // alias onto the theme's tokens and then remove.
  legacyTokens: { file: string; names: string[] }[];
  // App-defined tokens with the same name as one of the theme's: they
  // override the theme depending on stylesheet order, and can't be aliased
  // (var(--x) inside --x is circular), so a migration deletes them.
  collisions: { file: string; names: string[] }[];
  tailwind: { file: string; usesThemeTokens: boolean }[];
  componentLibraries: string[];
  scannedFiles: number;
  truncated: boolean;
}

async function listFiles(repoRoot: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: repoRoot, maxBuffer: 20_000_000 });
    return stdout.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function isStyleFile(file: string): boolean {
  if (file.split('/').some((segment) => SKIP_DIRS.has(segment))) return false;
  if (/\.min\.(js|css)$/.test(file) || file.endsWith('.d.ts')) return false;
  return STYLE_EXTENSIONS.has(path.extname(file).toLowerCase());
}

export async function auditThemeUsage(repoRoot: string): Promise<ThemeAudit> {
  const summary = summarizeAppTheme(repoRoot);
  const all = await listFiles(repoRoot);
  const candidates = all.filter(isStyleFile);
  const files = candidates.slice(0, MAX_FILES);

  const importedFrom: string[] = [];
  const byFile: ThemeAudit['hardCoded']['byFile'] = [];
  const legacyTokens: ThemeAudit['legacyTokens'] = [];
  const tailwind: ThemeAudit['tailwind'] = [];

  for (const file of files) {
    let text: string;
    try {
      const absolute = path.join(repoRoot, file);
      if ((await fs.stat(absolute)).size > MAX_FILE_BYTES) continue;
      text = await fs.readFile(absolute, 'utf8');
    } catch {
      continue;
    }
    if (/theme\/index\.css/.test(text)) importedFrom.push(file);
    if (/^tailwind\.config\.[cm]?[jt]s$/.test(path.basename(file))) {
      tailwind.push({ file, usesThemeTokens: /var\(--color-/.test(text) });
    }

    const tokenNames = new Set<string>();
    const samples: { line: number; text: string }[] = [];
    let count = 0;
    text.split('\n').forEach((line, i) => {
      const defs = [...line.matchAll(TOKEN_DEF)].map((m) => m[2]);
      defs.forEach((name) => tokenNames.add(name));
      // A token definition is reported as a legacy token, not as a stray literal.
      if (defs.length === 0 && (HEX.test(line) || FUNC.test(line))) {
        count++;
        if (samples.length < 3) samples.push({ line: i + 1, text: line.trim().slice(0, 140) });
      }
    });
    if (count > 0) byFile.push({ file, count, samples });
    if (tokenNames.size > 0 && /\.(css|scss|sass|less|styl|pcss)$/.test(file)) {
      legacyTokens.push({ file, names: [...tokenNames].slice(0, 40) });
    }
  }

  let componentLibraries: string[] = [];
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    componentLibraries = COMPONENT_LIBRARIES.filter(([name]) => name in deps).map(([, label]) => label);
  } catch {
    // no package.json — not a JS app, or not at the root
  }

  byFile.sort((a, b) => b.count - a.count);
  const themeTokens = new Set(tokenNames());
  const collisions = legacyTokens
    .map((t) => ({ file: t.file, names: t.names.filter((n) => themeTokens.has(n)) }))
    .filter((t) => t.names.length > 0);
  return {
    theme: summary && { name: summary.name, inSync: summary.inSync },
    importedFrom,
    hardCoded: { total: byFile.reduce((n, f) => n + f.count, 0), byFile },
    legacyTokens,
    collisions,
    tailwind,
    componentLibraries,
    scannedFiles: files.length,
    truncated: candidates.length > files.length,
  };
}

/** The audit as text, for the agents. */
export function formatThemeAudit(audit: ThemeAudit): string {
  const lines: string[] = [];
  lines.push(
    audit.theme
      ? `Theme: "${audit.theme.name}" (${THEME_DIR}/theme.json)${audit.theme.inSync ? '' : " — WARNING: the generated theme files don't match theme.json (hand-edited, or generated by an older Riff); ask the human to click Regenerate CSS on the app's Theme page in Riff"}.`
      : `Theme: none. This app has no Riff theme yet (no ${THEME_DIR}/theme.json). The human picks one in Riff; don't create theme files yourself.`
  );
  lines.push(
    audit.importedFrom.length === 0
      ? `Wired in: NO. Nothing imports ${THEME_DIR}/index.css yet.`
      : `Wired in: imported from ${audit.importedFrom.join(', ')}${audit.importedFrom.length > 1 ? ' (should be imported once, at the root entry only)' : ''}.`
  );
  lines.push(`Hard-coded colors outside ${THEME_DIR}/: ${audit.hardCoded.total} in ${audit.hardCoded.byFile.length} files.`);
  for (const f of audit.hardCoded.byFile.slice(0, 25)) {
    lines.push(`  ${f.file} (${f.count}): ${f.samples.map((s) => `L${s.line} ${s.text}`).join(' | ')}`);
  }
  if (audit.hardCoded.byFile.length > 25) lines.push(`  …and ${audit.hardCoded.byFile.length - 25} more files.`);
  lines.push(
    audit.legacyTokens.length === 0
      ? `App-defined CSS tokens outside ${THEME_DIR}/: none.`
      : `App-defined CSS tokens outside ${THEME_DIR}/ (alias these onto the theme's tokens, then remove them):`
  );
  for (const t of audit.legacyTokens.slice(0, 15)) lines.push(`  ${t.file}: ${t.names.join(', ')}`);
  if (audit.collisions.length > 0) {
    lines.push(
      "COLLISIONS: these app-defined tokens have the same names as the theme's own and will override it depending on " +
        "stylesheet order. Delete these definitions (don't alias them: --x: var(--x) is circular); usages then pick up the theme:"
    );
    for (const c of audit.collisions) lines.push(`  ${c.file}: ${c.names.join(', ')}`);
  }
  for (const t of audit.tailwind) {
    lines.push(`Tailwind config ${t.file}: ${t.usesThemeTokens ? 'maps to theme tokens' : 'does NOT reference the theme tokens yet'}.`);
  }
  if (audit.componentLibraries.length > 0) {
    lines.push(`Component libraries: ${audit.componentLibraries.join(', ')}. Point their theme config at the tokens rather than replacing them.`);
  }
  lines.push(`Scanned ${audit.scannedFiles} style/markup files${audit.truncated ? ' (capped, so some files were not scanned)' : ''}.`);
  return lines.join('\n');
}
