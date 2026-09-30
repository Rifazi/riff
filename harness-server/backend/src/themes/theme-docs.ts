import type { ThemeDefinition } from './presets.js';
import { COMPONENT_CATALOG, TONES, tokenNames } from './theme-css.js';

export const THEME_DIR = 'theme';
export const THEME_DOC_PATH = 'docs/theme.md';
// The one file that defines the app's theme; everything else in theme/ is generated from it.
export const THEME_DEFINITION_PATH = `${THEME_DIR}/theme.json`;

function catalogTable(): string {
  return [
    '| Component | Classes | Notes |',
    '| --- | --- | --- |',
    ...COMPONENT_CATALOG.map((c) => `| ${c.name} | \`${c.classes}\` | ${c.usage} |`),
  ].join('\n');
}

// Tailwind v4 reads theme variables from @theme; mapping under a ui-
// prefix avoids redefining a variable in terms of itself.
function tailwindSnippets(): string {
  const colors = tokenNames().filter((name) => name.startsWith('--color-'));
  const v3 = colors.map((name) => `      '${name.slice('--color-'.length)}': 'var(${name})',`).join('\n');
  const v4 = colors.map((name) => `  --color-ui-${name.slice('--color-'.length)}: var(${name});`).join('\n');
  return [
    'Tailwind v3 (`tailwind.config.*`):',
    '',
    '```js',
    'theme: {',
    '  extend: {',
    '    colors: {',
    v3,
    '    },',
    "    borderRadius: { sm: 'var(--radius-sm)', DEFAULT: 'var(--radius-md)', lg: 'var(--radius-lg)' },",
    "    fontFamily: { sans: 'var(--font-sans)', heading: 'var(--font-heading)', mono: 'var(--font-mono)' },",
    '  },',
    '},',
    '```',
    '',
    'Tailwind v4 (in the CSS file that imports tailwind), which gives classes like `bg-ui-primary`:',
    '',
    '```css',
    '@theme inline {',
    v4,
    '}',
    '```',
  ].join('\n');
}

/** docs/theme.md — for the humans and the agents working in the repo (it's indexed by search_docs). */
export function renderThemeDoc(theme: ThemeDefinition): string {
  return `# UI theme: ${theme.name}

${theme.description}

This app's look is defined in **one file, \`${THEME_DEFINITION_PATH}\`**: colors for light and dark
mode, fonts, heading weight, corner radius, border width, shadows and spacing density. Every page and
component takes its look from the CSS tokens generated from that file, so swapping or tweaking the
theme is a change to that one file, and no component or view needs touching.

| File | What it holds |
| --- | --- |
| \`${THEME_DEFINITION_PATH}\` | **The theme definition**, the only file to edit. Also readable as data by JS/TS code (charts, emails, canvas) |
| \`${THEME_DIR}/index.css\` | The single entry point. Imports the two files below |
| \`${THEME_DIR}/tokens.css\` | Generated: CSS custom properties (design tokens), light and dark |
| \`${THEME_DIR}/components.css\` | Generated: shared component classes (\`ui-*\`), built only from tokens |

## Changing the theme

- In Riff, open the app's **Theme** page to pick another theme or edit this one with a live preview.
  Saving rewrites \`${THEME_DEFINITION_PATH}\`, regenerates the CSS and this document, and commits.
- Or ask the requirements agent in a Dev Session ("make it warmer", "use our brand red #d00000"). It
  opens the same theme picker with its suggestion for you to review and apply.
- Or edit \`${THEME_DEFINITION_PATH}\` by hand, then click **Regenerate CSS** on the Theme page.

Never edit the generated CSS directly, because your changes would be lost on the next save.

## Wiring it in

Import \`${THEME_DIR}/index.css\` **once**, in the app's root entry (for example Next.js \`app/layout.tsx\`,
Vite/CRA \`src/main.tsx\`, or a \`<link rel="stylesheet">\` in plain HTML). Never import it per page or
per component.

Dark mode follows the OS by default. Set \`<html data-theme="dark">\` or \`data-theme="light"\` to
pin one.

## Rules

1. **No hard-coded design values.** Colors, font families, radii, shadows and spacing come from the
   tokens (\`var(--color-primary)\`, \`var(--space-4)\`, …). No hex, rgb or ad-hoc px values for these
   in components or views. That is what keeps the theme swappable.
2. **Build each UI element once.** If the app uses a component framework (React, Vue, Svelte, …), create
   one shared component per element (Button, Input, Card, Badge, Alert, …) in the app's shared
   components folder. Render the \`ui-*\` classes below inside it, and use that component in every view.
   Don't restyle elements page by page.
3. **Extend with tokens.** A new component styles itself with the tokens and lives next to the other
   shared components. Put app-specific tokens in the app's own stylesheet, defined in terms of these.
4. **Existing component libraries** (MUI, Chakra, shadcn, …) keep their components. Point the library's
   theme config at these tokens instead of introducing \`ui-*\` markup alongside them.

## Migrating existing styling onto the theme

For an app that already has its own colors, tokens or component styles:

1. **Survey.** List what styles the app today: token files, hard-coded colors, Tailwind config, component
   library theme config. (Dev Sessions agents run \`audit_theme\` for this.)
2. **Wire in.** Import \`${THEME_DIR}/index.css\` once at the root entry, before the app's own stylesheets.
3. **Alias, don't break.** Delete any old token that has the same name as a theme token (it would override
   the theme, and \`--x: var(--x)\` is circular). Redefine each differently named old token in terms of the
   theme's, e.g. \`--accent: var(--color-primary);\`, so every existing usage follows the theme straight away. If the app
   was dark-only, pin \`<html data-theme="dark">\` until light mode has been checked.
4. **Shared components.** Make the shared Button, Input, Card, … components render the \`ui-*\` classes (or
   restyle them with tokens). Delete duplicated per-page styles as each view moves over.
5. **Views.** Replace remaining hard-coded values view by view with tokens or shared components.
6. **Remove the old tokens.** Once nothing references an alias, delete it, until no design values are
   defined outside \`${THEME_DIR}/\`.
7. **Frameworks.** Point Tailwind or a component library's theme config at the tokens (snippets below).

Keep the app working after each step; a migration can land in several reviewable commits.

## Tokens

${tokenNames().map((name) => `\`${name}\``).join(', ')}.

Tones for badges and alerts: ${TONES.map((t) => `\`${t}\``).join(', ')}.

## Components

${catalogTable()}

Example:

\`\`\`html
<div class="ui-card">
  <div class="ui-card__header"><h2 class="ui-card__title">Invite a teammate</h2><span class="ui-badge ui-badge--success">Active</span></div>
  <div class="ui-card__body ui-stack">
    <label class="ui-field"><span class="ui-label">Email</span><input class="ui-input" type="email" /></label>
    <div class="ui-alert ui-alert--warning"><span class="ui-alert__title">Heads up</span>Invites expire after 7 days.</div>
  </div>
  <div class="ui-card__footer"><button class="ui-btn ui-btn--secondary">Cancel</button><button class="ui-btn">Send invite</button></div>
</div>
\`\`\`

## Utility-CSS frameworks

${tailwindSnippets()}
`;
}

export type ThemeBriefingRole = 'plan' | 'coding' | 'qa';

const MIGRATION_STEPS =
  `Migration order: (1) run audit_theme; (2) import ${THEME_DIR}/index.css once at the root entry, before the app's own ` +
  `styles; (3) delete any app-defined token with the same name as a theme token (audit_theme lists these as ` +
  `COLLISIONS; aliasing one to itself is circular), and alias each differently named one onto the theme's (e.g. ` +
  `--accent: var(--color-primary), a --color-primary-500 ramp onto --color-primary / --color-primary-soft) so existing ` +
  `usages follow the theme immediately (pin <html data-theme="dark"> if the app was dark-only and light mode isn't ` +
  `checked yet); (4) make the shared components (Button, Input, Card, …) render the ui-* classes or use tokens; (5) move ` +
  `views over, replacing hard-coded values with tokens or shared components; (6) delete aliases nothing references; ` +
  `(7) point Tailwind / component-library theme config at the tokens (snippets in ${THEME_DOC_PATH}). Keep the app working ` +
  `after every step.`;

/**
 * What each agent role needs to know about the app's theme. Delivered in
 * the system prompt on a stage's first turn and again, in the turn prompt,
 * whenever the theme changes mid-session (see agents/theme-context.ts). It
 * goes after any prompt override, since an override replaces the base
 * prompt wholesale.
 */
export function themeBriefing(role: ThemeBriefingRole, themeName: string | null): string {
  const picker =
    `The theme is chosen and edited by the human in Riff's theme picker (the app's Theme page in Riff, or by asking the ` +
    `requirements agent), which rewrites ${THEME_DEFINITION_PATH} and regenerates ${THEME_DIR}/*.css and ${THEME_DOC_PATH} ` +
    `on the base branch. The picker is part of Riff, never of this app: don't build a theme picker or switcher into the ` +
    `app unless the approved requirements explicitly ask for one for its end users.`;

  if (!themeName) {
    const noTheme =
      `\n\n# UI theme\n\nThis app has no Riff UI theme yet (no ${THEME_DEFINITION_PATH}). ${picker} Don't create theme files ` +
      `yourself. If this work adds or restyles UI, still keep design values in one place instead of scattering them, ` +
      `and mention that picking a theme in Riff first would let the UI build on it.`;
    return role === 'qa' ? '' : noTheme;
  }

  const rules =
    `This app uses the "${themeName}" UI theme, defined in ${THEME_DEFINITION_PATH}. ${picker}\n\n` +
    `Rules for all UI: colors, fonts, spacing, radius and shadows come only from the theme's CSS tokens ` +
    `(var(--color-*), var(--space-*), var(--radius-*), …), never hard-coded values, so swapping the theme restyles ` +
    `everything. Build each element once as a shared component using the ui-* classes (${COMPONENT_CATALOG.map((c) => c.name).join(', ')}) ` +
    `and reuse it in every view, with no per-page restyling. ${THEME_DIR}/index.css is imported exactly once, at the app's ` +
    `root entry. Never edit anything in ${THEME_DIR}/ or ${THEME_DOC_PATH}; if the work needs a theme change (a new ` +
    `color, font or radius), tell the human to make it in Riff's theme picker. Tokens and component details: ${THEME_DOC_PATH}.`;

  const byRole: Record<ThemeBriefingRole, string> = {
    plan:
      `Run audit_theme before planning UI work. If ${THEME_DIR}/index.css isn't imported yet, or the audit shows the app's ` +
      `own tokens or hard-coded colors in the areas the work touches, include the migration steps the work needs. ` +
      `When the requirements are a migration onto the theme, plan it in this order. ${MIGRATION_STEPS} With workstreams, ` +
      `put the root entry and the shared components in one workstream that the view workstreams depend on.`,
    coding:
      `Run audit_theme before you start UI work and again before you finish. Anything you add must pass it: no new ` +
      `hard-coded colors, and the theme imported once. When the work (or a UI change in an area not yet on the theme) ` +
      `needs the app moved onto the theme, follow this. ${MIGRATION_STEPS}`,
    qa:
      `Run audit_theme on the branch. Flag as findings: UI in the diff that hard-codes colors or other design values ` +
      `instead of using the tokens, ${THEME_DIR}/index.css missing or imported more than once, new per-page restyling ` +
      `of an element that has a shared component, a theme picker or switcher built into the app without being in the ` +
      `requirements, and any edit to ${THEME_DIR}/ or ${THEME_DOC_PATH}. For a migration, also check that every step ` +
      `the requirements asked for is done and the app still renders.`,
  };
  return `\n\n# UI theme\n\n${rules}\n\n${byRole[role]}`;
}
