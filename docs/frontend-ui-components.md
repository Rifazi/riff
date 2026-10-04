# Frontend UI Components

This document describes the centralized, theme-driven UI component library for the Riff frontend. All components are theme-aware and draw their colors and styling from Riff's generated theme tokens (`--color-*`, `--radius-*`), not from hard-coded values.

> **No theme is applied to this repo yet.** There is no `theme/theme.json`, so the generated `theme/*.css` files don't exist either. Every color in the app already resolves to the theme's documented token names; until a theme exists those names are filled in by a clearly-marked placeholder block in `globals.css` (plain named CSS colors, so it reads as scaffolding rather than a palette to maintain). See [Applying a theme](#applying-a-theme).

## Component Library

The component library is located at `frontend/src/components/ui/` and provides reusable, themed primitives used throughout the main app, journal UI, and Dev Sessions interface.

### Primitives

Each component below is defined once and imported wherever needed, ensuring consistency and single-source-of-truth maintenance:

- **`button.tsx`** (`Button`)
  - Usage: `import { Button } from '@/components/ui/button'`
  - Variants: `default`, `secondary`, `success`, `destructive`, `outline`, `ghost`, `link`
  - Sizes: `default`, `sm`, `lg`, `icon`
  - Used in: Recording controls, settings, dialogs, Dev Sessions actions, journal review flows
  - The off-theme `green`/`blue`/`red`/`gray` variants this button used to carry (literal Tailwind palette classes that bypassed the theme entirely — the original source of the "purple vs blue" inconsistency) have been **removed**. Their call sites were retargeted to `default`, `success` and `destructive`.

- **`dialog.tsx`** (`Dialog`, `DialogTrigger`, `DialogContent`, `DialogHeader`, `DialogTitle`, `DialogDescription`, `DialogFooter`)
  - Usage: `import { Dialog, DialogContent, ... } from '@/components/ui/dialog'`
  - Used in: Model download progress, retranscribe, permission checks, confirmations, import/update dialogs, Dev Sessions approval/confirm flows
  - Theme-aware: background, text, and border colors pulled from `--color-surface`, `--color-text`, `--color-border`

- **`card.tsx`** (`Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardContent`, `CardFooter`)
  - Usage: `import { Card, CardContent, ... } from '@/components/ui/card'`
  - Structure: `bg-card text-card-foreground border border-border rounded-lg shadow-sm`
  - Used in: Settings panels, meeting details, journal cards, Dev Sessions page shell, list items
  - Replaces all ad hoc `bg-white rounded-lg border border-gray-200 shadow-sm` wrappers

- **`input.tsx` & `select.tsx`** (`Input`, `Select`, `SelectTrigger`, `SelectValue`, `SelectContent`, `SelectItem`)
  - Usage: `import { Input } from '@/components/ui/input'` or `import { Select, ... } from '@/components/ui/select'`
  - Theme-aware: focus colors, borders, and backgrounds all drawn from theme tokens
  - Used in: Transcript editing, settings forms, search, device selection, language selection, API spec editing

- **`badge.tsx`** (`Badge`)
  - Usage: `import { Badge } from '@/components/ui/badge'`
  - Variants: `default`, `secondary`, `success`, `warning`, `destructive`, `info`, `outline`
  - Used in: Journal review count indicators, status pills, topic tags, Dev Sessions status/stage indicators
  - Replaces PageShell's local `Pill` component and its `neutral`/`blue`/`green`/`red`/`amber` tones
  - Replaces all ad hoc `rounded-full bg-* px-2 py-1` colored pill elements

- **`dropdown-menu.tsx`** (`DropdownMenu`, `DropdownMenuTrigger`, `DropdownMenuContent`, `DropdownMenuItem`)
  - Usage: `import { DropdownMenu, ... } from '@/components/ui/dropdown-menu'`
  - Used in: Recording device selection, model options, action menus
  - Already provided by shadcn/ui; integrated into consolidation

- **`spinner.tsx`** (`Spinner`)
  - Usage: `import { Spinner } from '@/components/ui/spinner'`
  - Props: `size` (`xs`, `sm`, `default`, `lg`), `className` for customization
  - Theme-aware: the ring is `border-current` over `text-primary`, so it inherits the theme's primary color by default and any `text-*` token override at the call site otherwise
  - Replaces all ad hoc `animate-spin rounded-full border-*` divs (found in StatusOverlays, AISummary, ChunkProgressDisplay, RecordingControls, ModelDownloadProgress, MeetingJournalStrip)

- **`skeleton.tsx`** (`Skeleton`)
  - Usage: `import { Skeleton } from '@/components/ui/skeleton'`
  - Pattern: `<Skeleton className="h-20 w-32 rounded-lg" />`
  - Theme-aware: `animate-pulse bg-muted`, i.e. the theme's `--color-surface-muted`
  - Replaces all ad hoc `animate-pulse bg-gray-100 rounded-lg` loading blocks

- **`tabs.tsx`** (`Tabs`, `TabsList`, `TabsTrigger`, `TabsContent`)
  - Usage: `import { Tabs, ... } from '@/components/ui/tabs'`
  - Used in: Settings tabs (preferences, models, language, etc.), Dev Sessions stage panels
  - Already provided by shadcn/ui; integrated into consolidation

- **`alert.tsx`** (`Alert`, `AlertTitle`, `AlertDescription`)
  - Usage: `import { Alert, ... } from '@/components/ui/alert'`
  - Variants: `default`, `destructive`, `success`, `warning`, `info`
  - Used in: Permission warnings, permission status, update notifications, Dev Sessions notices
  - Replaces PageShell's local `Notice` component

- **`sonner`** (Toast notifications — there is no `ui/toast.tsx`; sonner is the only toast mechanism)
  - Usage: `import { toast } from 'sonner'`
  - Configuration: a single `<Toaster>` in `frontend/src/app/layout.tsx`
  - Variants: `success`, `error`, `warning`, `info`. sonner's `richColors` prop (its own fixed green/red palette, independent of the theme) was **removed** in favor of `toastOptions.classNames`, which maps each tone onto theme tokens (`bg-success text-success-foreground`, `bg-destructive text-destructive-foreground`, and so on)
  - Used in: Recording status, download progress, journal filing, Dev Sessions approval feedback
  - `components/MessageToast.tsx`, a second hand-rolled toast with no importers anywhere in the repo, was deleted

## Theme Token Aliasing

There are three layers between a theme token and a Tailwind class, and only the first one is allowed to name a color.

**1. Riff's theme tokens** — `--color-bg`, `--color-surface`, `--color-surface-muted`, `--color-border`, `--color-text`, `--color-text-muted`, `--color-primary`, `--color-on-primary`, `--color-success`, `--color-warning`, `--color-danger`, `--color-info`, `--radius-*`. Generated into `theme/*.css` from `theme/theme.json` by Riff's theme picker. The single source of truth.

**2. The shadcn-style aliases in `globals.css`** (`:root` and `.dark`) — every one is a direct `var(--color-*)` reference, never a color literal:

- `--background: var(--color-bg)`, `--foreground: var(--color-text)`
- `--card` / `--popover`: `var(--color-surface)`, with `-foreground` on `var(--color-text)`
- `--primary: var(--color-primary)`, `--primary-foreground: var(--color-on-primary)`
- `--secondary` / `--muted` / `--accent`: `var(--color-surface-muted)` (`--muted-foreground` on `var(--color-text-muted)`)
- `--destructive: var(--color-danger)`
- `--border` / `--input`: `var(--color-border)`; `--ring: var(--color-primary)`; `--radius: var(--radius-md)`
- `--chart-1..5`: primary, success, info, warning, danger

Note what is _not_ here: there are no `--success`/`--warning`/`--info` aliases, because nothing needs them — Tailwind reads `--color-success`/`--color-warning`/`--color-info` straight from layer 1. The theme schema only defines an "on-primary" foreground, so `--destructive-foreground`, `--color-on-success`, `--color-on-warning` and `--color-on-info` are set to `white`, matching the theme system's own `.ui-btn--danger` convention (a named CSS color, not a hex literal, so it isn't a second palette to maintain).

**3. `tailwind.config.js`** maps those variables onto Tailwind color keys, plus `success`/`warning`/`info` (new, matching the badge and alert variants) and `chart-1..5`. The hard-coded `tertiary: '#64748b'` key was removed (it had no uses).

One non-obvious detail lives here: every color goes through a `themeColor()` helper rather than a plain `'var(--primary)'` string. Tailwind 3 can only inject an alpha channel into a color it can parse, and `var(...)` is unparseable — so with plain strings, **every utility with an opacity modifier is silently dropped**, and `bg-primary/10`, `hover:bg-primary/90` and the Alert tints would render as nothing at all. `themeColor()` returns a function, takes the alpha Tailwind hands it, and blends with `color-mix()`, which works for whatever color format the theme emits (hex, `rgb()`, `oklch()`, ...). The color-less forms of `border`, `ring` and `ring-offset` are repointed at the theme too, since Tailwind's defaults for those are literal palette values (`gray-200`, `blue-500`).

Together this means applying or changing a theme requires no per-component code changes.

### Applying a theme

Pick a theme on the app's Theme page in Riff (Dev Sessions → Apps → Theme). That writes `theme/theme.json` and generates `theme/*.css`. Then, in `globals.css`:

1. Add `@import "../../../theme/index.css";` as the first line, above the `@tailwind` directives.
2. Delete the `PLACEHOLDER TOKENS` block.

Until step 2 happens the app still renders correctly either way: the placeholder block sits in `@layer base` while `theme/index.css` is imported unlayered, so a real theme outranks it regardless of import order. `audit_theme` reports the placeholder definitions as colliding with the theme's own token names — that warning is what step 2 resolves, and it is expected while no theme exists.

## Known Limitations and Future Cleanup

### No theme applied yet

The biggest open item is not code: no theme has been picked for this app, so the UI currently renders on the placeholder tokens described above. Picking one in Riff and doing the two-line swap in [Applying a theme](#applying-a-theme) is what turns this work into its intended visible result.

### Theme-editing UI keeps its own color values

The theme studio is also the only place in the frontend still rendering native `<select>` elements (`themes/ThemeEditor.tsx`, and `themes/ThemeShowcase.tsx`'s `ui-select` sample): both deliberately render the _previewed_ theme's own CSS rather than this app's `ui/select`, which is the point of the preview. Everywhere else now uses `ui/select`.

`components/DevSessions/themes/ThemeEditor.tsx` contains literal shadow values (`0 1px 2px rgb(15 23 42 / 0.06)`, ...) as selectable presets. These are **data, not styling**: they are candidate values the user picks for _another_ app's theme, so they can't come from this app's own tokens. `audit_theme` flags them; that is a false positive, and the requirements for this work carve the target-app theme-editing logic out of scope explicitly.

### Chart Colors

The Dev Sessions `TokenUsagePanel` stage breakdown chart (requirements, plan, coding, QA) used to use a hard-coded categorical color palette, hand-picked for colorblind accessibility (CVD-safe separation between adjacent stages). It now reads `var(--chart-1)` through `var(--chart-4)` — the same theme-driven chart tokens `globals.css` aliases onto `--color-primary`/`--color-success`/`--color-info`/`--color-warning` — for consistency with the rest of the app. This is a deliberate trade-off: an arbitrary theme's primary/success/info/warning hues aren't guaranteed to preserve the original CVD separation, so the chart always ships with a legend and a table view (`DailyTable`) as a non-color-dependent fallback, and any future theme change is worth a manual check of the chart's visual distinction.

## Architecture and Patterns

### Component Composition

All central components follow shadcn/ui patterns:

- Use of `cva` (class-variance-authority) for variant definitions
- `forwardRef` and `React.ComponentPropsWithoutRef` for TypeScript integration
- Naming conventions: compound components use a root + subcomponent pattern (e.g., `Card` + `CardHeader`)

### Styling Approach

- **No inline styles or tailwind literals for colors**: All colors come from CSS variables
- **Utility classes for layout**: Spacing, sizing, and layout still use Tailwind utility classes (e.g., `p-4`, `flex`, `gap-2`)
- **Semantic naming**: Classes use semantic token names (`bg-card`, `text-muted-foreground`) rather than color scale names (`bg-gray-100`, `text-slate-500`)

### Provider Setup

The app's root layout (`frontend/src/app/layout.tsx`) includes:

- `<Toaster>` for sonner-based toast notifications, themed through `toastOptions.classNames` (see the `sonner` entry above)
- The `globals.css` import, which defines the token layers described in [Theme Token Aliasing](#theme-token-aliasing)
- No other global providers needed for the UI component library

## File Locations Reference

| Component | File                   | Used In                                                         |
| --------- | ---------------------- | --------------------------------------------------------------- |
| Button    | `ui/button.tsx`        | ~50+ files across main app, Dev Sessions, journal               |
| Dialog    | `ui/dialog.tsx`        | Modals, confirmations, retranscribe, import, updates            |
| Card      | `ui/card.tsx`          | Settings, meeting details, journal, Dev Sessions pages          |
| Input     | `ui/input.tsx`         | Forms, search, transcript editing                               |
| Select    | `ui/select.tsx`        | Device selection, language, model options                       |
| Badge     | `ui/badge.tsx`         | Status indicators, tags, pills, counts                          |
| Dropdown  | `ui/dropdown-menu.tsx` | Device/model menus, actions                                     |
| Spinner   | `ui/spinner.tsx`       | Loading states (status overlays, summary generation, downloads) |
| Skeleton  | `ui/skeleton.tsx`      | Skeleton screens (model managers, device selection, settings)   |
| Tabs      | `ui/tabs.tsx`          | Settings shell, Dev Sessions stages                             |
| Alert     | `ui/alert.tsx`         | Warnings, notices, status messages                              |
| Toast     | sonner + layout.tsx    | Notifications (success, error, info)                            |

## Affected Screens and Pages

The following main app, journal, and Dev Sessions screens/components have been consolidated onto the central library:

**Main App**

- Recording page (`app/page.tsx`) and controls
- Meetings list (`app/meetings/page.tsx`)
- Meeting details and AI summary (`app/meeting-details/**`)
- Settings tabs and panels (`app/settings/**`)
- Sidebar and navigation (`components/Sidebar/**`)
- Onboarding flow (`components/onboarding/**`)
- Various dialogs and modals (retranscribe, import, update, permissions)

**Journal**

- Shelf and notebook pages (`app/journal/**`)
- Entry cards and review flow (`components/Journal/**`)
- Meeting journal strip (`components/MeetingDetails/MeetingJournalStrip.tsx`)

**Dev Sessions**

- Page shell and app chrome (`components/DevSessions/PageShell.tsx`)
- Session and chat UI (`components/DevSessions/ChatPane.tsx`, etc.)
- Apps pages (`app/dev-sessions/apps/**`)
- Stage and team panels (`components/DevSessions/stages/**`)
- Token usage charts (`components/DevSessions/TokenUsagePanel.tsx`)
- Theme studio (preview/editor, excluding theme-editing logic for target apps)

## Verification and Auditing

`audit_theme` is a **Riff agent tool, not an npm script** — there is nothing to run from a shell. Ask an agent in a Dev Session to run it; it reports hard-coded colors outside `theme/`, app-defined tokens that should be aliased onto the theme, and whether the Tailwind config references the theme.

The same check runs automatically: `frontend/tests/theme/no-palette-classes.test.ts` walks `frontend/src` on every `npm test` and fails on a literal Tailwind palette class or a literal `white`/`black` utility, with the carve-outs below encoded as explicit allowlists (each one justified in a comment, and each kept honest by a test that fails if the file stops needing it).

To check the same thing by hand, grep for literal palette classes, literal white/black utilities, and raw color literals:

```bash
# numbered palette classes
git grep -nE '(bg|text|border|ring|divide|from|via|to|placeholder|shadow|fill|stroke)-(gray|slate|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-[0-9]{2,3}' -- frontend/src
# literal white/black utilities
git grep -nE '(bg|text|border|ring|fill|stroke|from|via|to)-(white|black)(/[0-9]{1,3})?' -- frontend/src
# raw color literals
git grep -nE '#[0-9a-fA-F]{3,8}|rgba?\(|hsla?\(' -- frontend/src
```

None of the three comes back empty — each has a short, deliberate set of expected hits, listed below. Anything outside this table is a regression:

| Grep                  | Expected hits                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Palette classes       | `lib/journal/format.ts` (per-notebook cover colors, chosen per notebook and stored in the database) and `lib/dev-sessions/agents.ts` (per-engineer lane colors, one recognisable hue per roster member across the Plan and Coding tabs). Both are color-as-data, not chrome.                                                                                                                                                                                                                                                         |
| White/black utilities | The modal scrims in `ui/dialog.tsx` and `ui/sheet.tsx` (`bg-black/80`), the drag-and-drop import overlay in `ImportAudio/ImportDropOverlay.tsx` (`bg-black/60` plus the `text-white` label that sits on it), the swatch ring in `DevSessions/themes/ThemeTile.tsx` (`border-white`), and the hairline on a cover-colored pill in `MeetingDetails/MeetingJournalStrip.tsx` (`border-black/5`). All are veils or hairlines drawn over arbitrary content, where a fixed translucent black/white is the intended effect under any theme. |
| Color literals        | The shadow presets in `themes/ThemeEditor.tsx` (see above), plus the placeholder token block in `globals.css` until a theme is applied.                                                                                                                                                                                                                                                                                                                                                                                              |

### Lint and test scripts

Before this work the repo root had no working `lint` or `test` script, so the frontend's eslint rules were never actually enforced and a backlog of pre-existing violations had accumulated. The root scripts are now wired up to the frontend's eslint config and the bun test suite.

Rather than relaxing a rule repo-wide, `frontend/eslint.config.mjs` keeps three explicit lists of the legacy files that carry that backlog — `legacyExplicitAnyFiles`, `legacyUnusedVarsFiles` and `legacyUnescapedEntitiesFiles` — and switches `@typescript-eslint/no-explicit-any`, `@typescript-eslint/no-unused-vars` and `react/no-unescaped-entities` **off for those files only**. Every other file in the frontend, including every new one, is held to the rules at their default error level. When you clean a legacy file up, delete its entry; never add a new file to a list.

## Future Enhancements

- Apply a theme (see [Applying a theme](#applying-a-theme)) and delete the placeholder token block
- Consider extracting form-related compound components (`FormField`, `FormLabel`, etc.) into the library if used widely
- Re-check the TokenUsagePanel chart's colorblind separation whenever the theme changes, since its series now follow the theme's primary/success/info/warning hues
- Maintain the library as new screens are added to the app
