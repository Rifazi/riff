import { THEME_PRESETS, type Density, type ThemeColors, type ThemeDefinition } from './presets.js';

// Renders a ThemeDefinition to CSS. Two outputs share every token below:
//  - the files written into an app's repo (renderRepoTokensCss +
//    renderComponentsCss()), where tokens sit on :root and follow the OS
//    color scheme unless <html data-theme="light|dark"> pins one;
//  - the Apps page preview, which sets tokenMap() as inline custom
//    properties on a [data-ui-theme] wrapper and loads the component rules
//    once, scoped to such wrappers (previewComponentsCss), so any number of
//    themes, including unsaved edits, render side by side inside Riff.
// Components only ever reference tokens, so they are emitted once and
// every theme restyles them.

const COLOR_TOKENS: Record<keyof ThemeColors, string> = {
  bg: '--color-bg',
  surface: '--color-surface',
  surfaceMuted: '--color-surface-muted',
  border: '--color-border',
  text: '--color-text',
  textMuted: '--color-text-muted',
  primary: '--color-primary',
  onPrimary: '--color-on-primary',
  success: '--color-success',
  warning: '--color-warning',
  danger: '--color-danger',
  info: '--color-info',
};

const DENSITY: Record<Density, { controlHeight: number; space: number; fontSize: number }> = {
  compact: { controlHeight: 32, space: 4, fontSize: 13 },
  comfortable: { controlHeight: 36, space: 4, fontSize: 14 },
  spacious: { controlHeight: 40, space: 4.5, fontSize: 15 },
};

// Derived from the color tokens rather than stored per preset, so every
// theme gets hover/soft/focus states that stay consistent with its palette.
// Mixing toward --color-text darkens in light mode and lightens in dark.
const DERIVED_TOKENS: [string, string][] = [
  ['--color-primary-hover', 'color-mix(in srgb, var(--color-primary) 85%, var(--color-text))'],
  ['--color-primary-soft', 'color-mix(in srgb, var(--color-primary) 12%, var(--color-surface))'],
  ['--focus-ring', '0 0 0 3px color-mix(in srgb, var(--color-primary) 35%, transparent)'],
];

export const TONES = ['primary', 'success', 'warning', 'danger', 'info'] as const;

function colorDeclarations(colors: ThemeColors): string[] {
  return (Object.keys(COLOR_TOKENS) as (keyof ThemeColors)[]).map((key) => `${COLOR_TOKENS[key]}: ${colors[key]};`);
}

function staticTokens(theme: ThemeDefinition): [string, string][] {
  const d = DENSITY[theme.density];
  return [
    ['--font-sans', theme.fonts.sans],
    ['--font-heading', theme.fonts.heading],
    ['--font-mono', theme.fonts.mono],
    ['--font-weight-heading', String(theme.headingWeight)],
    ['--font-size-xs', `${d.fontSize - 2}px`],
    ['--font-size-sm', `${d.fontSize - 1}px`],
    ['--font-size-base', `${d.fontSize}px`],
    ['--font-size-lg', `${d.fontSize + 3}px`],
    ['--font-size-xl', `${d.fontSize + 8}px`],
    ['--radius-sm', `${theme.radius.sm}px`],
    ['--radius-md', `${theme.radius.md}px`],
    ['--radius-lg', `${theme.radius.lg}px`],
    ['--radius-full', `${theme.radius.full}px`],
    ['--border-width', `${theme.borderWidth}px`],
    ['--shadow-sm', theme.shadow.sm],
    ['--shadow-md', theme.shadow.md],
    ['--control-height', `${d.controlHeight}px`],
    ...[1, 2, 3, 4, 5, 6, 8].map((n): [string, string] => [`--space-${n}`, `${n * d.space}px`]),
    ...DERIVED_TOKENS,
  ];
}

function staticDeclarations(theme: ThemeDefinition): string[] {
  return staticTokens(theme).map(([name, value]) => `${name}: ${value};`);
}

function block(selector: string, declarations: string[]): string {
  return `${selector} {\n${declarations.map((line) => `  ${line}`).join('\n')}\n}`;
}

/** Every token name the theme defines, for docs and agent prompts. */
export function tokenNames(): string[] {
  return [...Object.values(COLOR_TOKENS), ...staticTokens(THEME_PRESETS[0]).map(([name]) => name)];
}

// Splits a selector list on its top-level commas only, so `:is(h1, h2)`
// stays one selector.
function splitSelectorList(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of list) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current.trim());
  return parts;
}

export type ThemeMode = 'light' | 'dark';

/** Every custom property a mode sets, for the preview's inline styles. */
export function tokenMap(theme: ThemeDefinition, mode: ThemeMode): Record<string, string> {
  const colors = (Object.keys(COLOR_TOKENS) as (keyof ThemeColors)[]).map((key) => [COLOR_TOKENS[key], theme[mode][key]]);
  return Object.fromEntries([...colors, ...staticTokens(theme)]);
}

export function tokenMaps(theme: ThemeDefinition): Record<ThemeMode, Record<string, string>> {
  return { light: tokenMap(theme, 'light'), dark: tokenMap(theme, 'dark') };
}

export function renderRepoTokensCss(theme: ThemeDefinition, definitionPath: string): string {
  const dark = colorDeclarations(theme.dark);
  return [
    `/* ${theme.name.replace(/\*\//g, '')} theme tokens, generated by Riff Dev Sessions from ${definitionPath}. ` +
      `Edit the theme there (or from Riff's Theme page), not here. */`,
    block(':root', ['color-scheme: light dark;', ...colorDeclarations(theme.light), ...staticDeclarations(theme)]),
    `@media (prefers-color-scheme: dark) {\n${block(':root:not([data-theme="light"])', dark).replace(/^/gm, '  ')}\n}`,
    block(':root[data-theme="dark"]', dark),
    block(':root[data-theme="light"]', ['color-scheme: light;']),
    '',
  ].join('\n\n');
}

/**
 * The shared component classes. `scope` prefixes every rule (the preview's
 * wrapper selector); `root` is where page-level base styles go — `body` in
 * a repo, the wrapper itself in the preview.
 */
export function renderComponentsCss(opts: { scope?: string; root?: string; layer?: string } = {}): string {
  const { scope = '', root = 'body', layer } = opts;
  const s = (selector: string) =>
    splitSelectorList(selector)
      .map((part) => `${scope} ${part}`.trim())
      .join(', ');
  const tones = TONES.map((tone) => `${s(`.ui-badge--${tone}, .ui-alert--${tone}`)} { --tone: var(--color-${tone}); }`);

  const rules = `
${root} {
  margin: 0;
  background: var(--color-bg);
  color: var(--color-text);
  font-family: var(--font-sans);
  font-size: var(--font-size-base);
  line-height: 1.5;
}
${s(':is(h1, h2, h3, h4), .ui-heading')} { font-family: var(--font-heading); font-weight: var(--font-weight-heading); line-height: 1.25; }
${s('code, kbd, pre')} { font-family: var(--font-mono); }
${s('.ui-muted')} { color: var(--color-text-muted); }
${s('.ui-stack')} { display: flex; flex-direction: column; gap: var(--space-4); }
${s('.ui-row')} { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-3); }

${s(':is(.ui-btn, .ui-input, .ui-select, .ui-textarea, .ui-switch, .ui-tab):focus-visible')} { outline: none; box-shadow: var(--focus-ring); }

${s('.ui-btn')} {
  display: inline-flex; align-items: center; justify-content: center; gap: var(--space-2);
  height: var(--control-height); padding: 0 var(--space-4);
  border: var(--border-width) solid transparent; border-radius: var(--radius-md);
  background: var(--color-primary); color: var(--color-on-primary);
  font: inherit; font-size: var(--font-size-sm); font-weight: 600; white-space: nowrap; text-decoration: none;
  cursor: pointer; transition: background-color 0.15s, border-color 0.15s, color 0.15s;
}
${s('.ui-btn:hover')} { background: var(--color-primary-hover); }
${s('.ui-btn--secondary')} { background: var(--color-surface); color: var(--color-text); border-color: var(--color-border); }
${s('.ui-btn--secondary:hover, .ui-btn--ghost:hover')} { background: var(--color-surface-muted); }
${s('.ui-btn--ghost')} { background: transparent; color: var(--color-text); }
${s('.ui-btn--danger')} { background: var(--color-danger); color: #fff; }
${s('.ui-btn--danger:hover')} { background: color-mix(in srgb, var(--color-danger) 85%, var(--color-text)); }
${s('.ui-btn--sm')} { height: calc(var(--control-height) - 8px); padding: 0 var(--space-3); font-size: var(--font-size-xs); }
${s('.ui-btn:disabled, .ui-btn[aria-disabled="true"]')} { opacity: 0.5; cursor: not-allowed; }

${s('.ui-field')} { display: flex; flex-direction: column; gap: var(--space-1); }
${s('.ui-label')} { font-size: var(--font-size-sm); font-weight: 600; color: var(--color-text); }
${s('.ui-hint')} { font-size: var(--font-size-xs); color: var(--color-text-muted); }
${s('.ui-hint--error')} { color: var(--color-danger); }
${s('.ui-input, .ui-select, .ui-textarea')} {
  box-sizing: border-box; width: 100%; height: var(--control-height); padding: 0 var(--space-3);
  border: var(--border-width) solid var(--color-border); border-radius: var(--radius-md);
  background: var(--color-surface); color: var(--color-text);
  font: inherit; font-size: var(--font-size-base);
  transition: border-color 0.15s, box-shadow 0.15s;
}
${s('.ui-input::placeholder, .ui-textarea::placeholder')} { color: var(--color-text-muted); }
${s('.ui-input:focus, .ui-select:focus, .ui-textarea:focus')} { border-color: var(--color-primary); }
${s('.ui-input[aria-invalid="true"], .ui-textarea[aria-invalid="true"]')} { border-color: var(--color-danger); }
${s('.ui-textarea')} { height: auto; min-height: calc(var(--control-height) * 2.5); padding: var(--space-2) var(--space-3); resize: vertical; }
${s('.ui-select')} {
  appearance: none; padding-right: var(--space-8);
  background-image: linear-gradient(45deg, transparent 50%, currentColor 50%), linear-gradient(135deg, currentColor 50%, transparent 50%);
  background-position: calc(100% - 17px) 50%, calc(100% - 12px) 50%;
  background-size: 5px 5px; background-repeat: no-repeat;
}

${s('.ui-choice')} { display: inline-flex; align-items: center; gap: var(--space-2); font-size: var(--font-size-sm); cursor: pointer; }
${s('.ui-check')} { width: 16px; height: 16px; margin: 0; accent-color: var(--color-primary); }
${s('.ui-switch')} {
  appearance: none; position: relative; flex-shrink: 0; width: 36px; height: 20px; margin: 0;
  border-radius: var(--radius-full); background: var(--color-border); cursor: pointer; transition: background-color 0.15s;
}
${s('.ui-switch::before')} {
  content: ''; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px;
  border-radius: var(--radius-full); background: var(--color-surface); box-shadow: var(--shadow-sm); transition: transform 0.15s;
}
${s('.ui-switch:checked')} { background: var(--color-primary); }
${s('.ui-switch:checked::before')} { transform: translateX(16px); }

${s('.ui-card')} {
  background: var(--color-surface); border: var(--border-width) solid var(--color-border);
  border-radius: var(--radius-lg); box-shadow: var(--shadow-sm); overflow: hidden;
}
${s('.ui-card__header')} {
  display: flex; align-items: center; justify-content: space-between; gap: var(--space-3);
  padding: var(--space-4) var(--space-5); border-bottom: var(--border-width) solid var(--color-border);
}
${s('.ui-card__title')} { margin: 0; font-family: var(--font-heading); font-weight: var(--font-weight-heading); font-size: var(--font-size-lg); }
${s('.ui-card__body')} { padding: var(--space-5); }
${s('.ui-card__footer')} {
  display: flex; justify-content: flex-end; gap: var(--space-2); padding: var(--space-3) var(--space-5);
  border-top: var(--border-width) solid var(--color-border); background: var(--color-surface-muted);
}

${s('.ui-badge')} { --tone: var(--color-text-muted); }
${s('.ui-alert')} { --tone: var(--color-info); }
${tones.join('\n')}
${s('.ui-badge')} {
  display: inline-flex; align-items: center; gap: var(--space-1); padding: 2px var(--space-2);
  border: 1px solid color-mix(in srgb, var(--tone) 30%, var(--color-surface)); border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--tone) 12%, var(--color-surface)); color: color-mix(in srgb, var(--tone) 80%, var(--color-text));
  font-size: var(--font-size-xs); font-weight: 600; white-space: nowrap;
}
${s('.ui-alert')} {
  display: flex; flex-direction: column; gap: var(--space-1); padding: var(--space-3) var(--space-4);
  border: var(--border-width) solid color-mix(in srgb, var(--tone) 35%, var(--color-surface)); border-left: 4px solid var(--tone);
  border-radius: var(--radius-md); background: color-mix(in srgb, var(--tone) 8%, var(--color-surface));
  font-size: var(--font-size-sm);
}
${s('.ui-alert__title')} { font-weight: 600; color: color-mix(in srgb, var(--tone) 75%, var(--color-text)); }

${s('.ui-table')} { width: 100%; border-collapse: collapse; font-size: var(--font-size-sm); }
${s('.ui-table th')} {
  padding: var(--space-2) var(--space-4); text-align: left; background: var(--color-surface-muted);
  color: var(--color-text-muted); font-size: var(--font-size-xs); font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase;
  border-bottom: var(--border-width) solid var(--color-border);
}
${s('.ui-table td')} { padding: var(--space-3) var(--space-4); border-bottom: 1px solid var(--color-border); }
${s('.ui-table tbody tr:last-child td')} { border-bottom: 0; }
${s('.ui-table tbody tr:hover')} { background: color-mix(in srgb, var(--color-surface-muted) 60%, var(--color-surface)); }

${s('.ui-tabs')} { display: flex; gap: var(--space-1); border-bottom: var(--border-width) solid var(--color-border); }
${s('.ui-tab')} {
  appearance: none; margin-bottom: calc(var(--border-width) * -1); padding: var(--space-2) var(--space-3);
  border: 0; border-bottom: 2px solid transparent; background: none; color: var(--color-text-muted);
  font: inherit; font-size: var(--font-size-sm); font-weight: 500; cursor: pointer;
}
${s('.ui-tab:hover')} { color: var(--color-text); }
${s('.ui-tab[aria-selected="true"]')} { color: var(--color-primary); border-bottom-color: var(--color-primary); }

${s('.ui-nav')} {
  display: flex; align-items: center; gap: var(--space-4); min-height: calc(var(--control-height) + var(--space-6));
  padding: 0 var(--space-5); background: var(--color-surface); border-bottom: var(--border-width) solid var(--color-border);
}
${s('.ui-nav__brand')} { font-family: var(--font-heading); font-weight: 700; font-size: var(--font-size-lg); }
${s('.ui-nav__link')} {
  padding: var(--space-1) var(--space-2); border-radius: var(--radius-sm); color: var(--color-text-muted);
  font-size: var(--font-size-sm); font-weight: 500; text-decoration: none;
}
${s('.ui-nav__link:hover, .ui-nav__link[aria-current="page"]')} { color: var(--color-text); background: var(--color-surface-muted); }

${s('.ui-link')} { color: var(--color-primary); text-decoration: underline; text-underline-offset: 2px; }
${s('.ui-avatar')} {
  display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; flex-shrink: 0;
  border-radius: var(--radius-full); background: var(--color-primary-soft); color: var(--color-primary);
  font-size: var(--font-size-xs); font-weight: 700;
}
`.trim();

  return layer ? `@layer ${layer} {\n${rules.replace(/^(?=.)/gm, '  ')}\n}\n` : `${rules}\n`;
}

const PREVIEW_ROOT = '[data-ui-theme]';

/** The component rules once, scoped to any preview wrapper; tokens come inline. */
export function previewComponentsCss(): string {
  return renderComponentsCss({ scope: PREVIEW_ROOT, root: PREVIEW_ROOT });
}

// What each shared class is for — feeds docs/theme.md and the agents'
// prompt, so the catalog they're told to use is always the one generated.
export const COMPONENT_CATALOG: { name: string; classes: string; usage: string }[] = [
  { name: 'Button', classes: '.ui-btn, .ui-btn--secondary, .ui-btn--ghost, .ui-btn--danger, .ui-btn--sm', usage: 'Primary by default; one primary action per view.' },
  { name: 'Form field', classes: '.ui-field > .ui-label + (.ui-input | .ui-select | .ui-textarea) + .ui-hint[--error]', usage: 'aria-invalid="true" on the control marks an error.' },
  { name: 'Checkbox / radio', classes: '.ui-choice > input.ui-check', usage: 'Native inputs, tinted with the primary color.' },
  { name: 'Switch', classes: 'input[type="checkbox"][role="switch"].ui-switch', usage: 'On/off settings that apply immediately.' },
  { name: 'Card', classes: '.ui-card > .ui-card__header (.ui-card__title) + .ui-card__body + .ui-card__footer', usage: 'Groups related content; the page background is --color-bg.' },
  { name: 'Badge', classes: `.ui-badge, ${TONES.map((t) => `.ui-badge--${t}`).join(', ')}`, usage: 'Short status labels.' },
  { name: 'Alert', classes: `.ui-alert > .ui-alert__title + text, ${TONES.map((t) => `.ui-alert--${t}`).join(', ')}`, usage: 'Inline messages; info by default.' },
  { name: 'Table', classes: 'table.ui-table', usage: 'Tabular data with a muted header row.' },
  { name: 'Tabs', classes: '.ui-tabs > button.ui-tab[aria-selected]', usage: 'Switching between views of the same object.' },
  { name: 'Top navigation', classes: '.ui-nav > .ui-nav__brand + a.ui-nav__link[aria-current="page"]', usage: 'App header.' },
  { name: 'Link, avatar, text', classes: '.ui-link, .ui-avatar, .ui-muted, .ui-heading', usage: 'Inline links, initials avatars, secondary text.' },
  { name: 'Layout', classes: '.ui-stack, .ui-row', usage: 'Vertical and horizontal spacing on the theme scale.' },
];
