# Frontend UI Components

This document describes the centralized, theme-driven UI component library for the Riff frontend. All components are theme-aware and draw their colors and styling from the generated `theme/tokens.css` CSS variables, not from hard-coded values.

## Component Library

The component library is located at `frontend/src/components/ui/` and provides reusable, themed primitives used throughout the main app, journal UI, and Dev Sessions interface.

### Primitives

Each component below is defined once and imported wherever needed, ensuring consistency and single-source-of-truth maintenance:

- **`button.tsx`** (`Button`)
  - Usage: `import { Button } from '@/components/ui/button'`
  - Variants: `default`, `secondary`, `success`, `destructive`, `outline`, `ghost`
  - Used in: Recording controls, settings, dialogs, Dev Sessions actions, journal review flows
  - Note: The `green`/`blue`/`red`/`gray` variants are deprecated (left in place for gradual migration) but are no longer used after consolidation; use `default`, `success`, `destructive`, or semantic variants instead

- **`dialog.tsx`** (`Dialog`, `DialogTrigger`, `DialogContent`, `DialogHeader`, `DialogTitle`, `DialogDescription`, `DialogFooter`)
  - Usage: `import { Dialog, DialogContent, ... } from '@/components/ui/dialog'`
  - Used in: Model download progress, retranscribe, permission checks, confirmations, import/update dialogs, Dev Sessions approval/confirm flows
  - Theme-aware: background, text, and border colors pulled from `--color-card`, `--color-text`, `--color-border`

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
  - Variants: `default`, `secondary`, `success`, `warning`, `destructive`, `info`
  - Used in: Journal review count indicators, status pills, topic tags, Dev Sessions status/stage indicators
  - Replaces all ad hoc `rounded-full bg-* px-2 py-1` colored pill elements

- **`dropdown-menu.tsx`** (`DropdownMenu`, `DropdownMenuTrigger`, `DropdownMenuContent`, `DropdownMenuItem`)
  - Usage: `import { DropdownMenu, ... } from '@/components/ui/dropdown-menu'`
  - Used in: Recording device selection, model options, action menus
  - Already provided by shadcn/ui; integrated into consolidation

- **`spinner.tsx`** (`Spinner`)
  - Usage: `import { Spinner } from '@/components/ui/spinner'`
  - Props: `size` (small/medium/large), `className` for customization
  - Theme-aware: border colors draw from `--color-primary`
  - Replaces all ad hoc `animate-spin rounded-full border-*` divs (found in StatusOverlays, AISummary, ChunkProgressDisplay, RecordingControls, ModelDownloadProgress, MeetingJournalStrip)

- **`skeleton.tsx`** (`Skeleton`)
  - Usage: `import { Skeleton } from '@/components/ui/skeleton'`
  - Pattern: `<Skeleton className="h-20 w-32 rounded-lg" />`
  - Theme-aware: background color from `--color-muted`
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

- **`toast.tsx` / `sonner`** (Toast notifications)
  - Usage: `import { toast } from 'sonner'`
  - Configuration: Integrated in `frontend/src/app/layout.tsx` with `<Toaster>` and theme-aware `toastOptions`
  - Variants: success, error, info (rendered via `richColors` and CSS variable hooks)
  - Used in: Recording status, download progress, journal filing, Dev Sessions approval feedback

## Theme Token Aliasing

The app's CSS variables in `frontend/src/app/globals.css` are now aliased directly onto the generated theme tokens, rather than defining their own hard-coded HSL values:

**In globals.css** (`:root` and `.dark` selectors):

- `--primary: var(--color-primary)`
- `--background: var(--color-bg)`
- `--card: var(--color-card)`
- `--foreground: var(--color-text)`
- `--destructive: var(--color-danger)`
- `--success: var(--color-success)` (new)
- `--warning: var(--color-warning)` (new)
- `--info: var(--color-info)` (new)
- ... and others (see the full `:root` block in globals.css for complete list)

**In tailwind.config.js**:

- Tailwind's `colors` block references `var(--color-*)` tokens instead of hard-coded hex/HSL values
- The hardcoded `tertiary: '#64748b'` color has been removed (no uses)
- New color keys `success`, `warning`, `info` added to match badge and alert variants

This ensures that when a theme is applied via Riff's theme picker (which generates `theme/theme.json` → `theme/tokens.css`), every component automatically renders in the theme's colors without any per-component code changes.

## Known Limitations and Future Cleanup

### Deliberately-Left-In-Place Dead Code

The `button.tsx` variant set still includes the deprecated `green`, `blue`, `red`, and `gray` cva entries. These are **not used anywhere** after consolidation (all call sites have been retargeted to `default`, `success`, or `destructive`), but are left in place rather than removing them in a separate pass. This is a minor code-cleanliness issue, not a functional one, and can be cleaned up in a future maintenance pass without affecting any feature.

### Chart Colors

The Dev Sessions `TokenUsagePanel` uses a hard-coded categorical color palette for its stage breakdown chart (requirements, plan, coding, QA). This palette was specifically chosen for colorblind accessibility (CVD-safe separation between adjacent stages). When a theme is applied, these should ideally map to the theme's semantic color ramp (primary, success, info, warning) for consistency, but this represents a deliberate trade-off: arbitrary themes may not preserve the original CVD separation, so any future updates should pair a theme change with manual verification of the chart's visual distinction.

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

- `<Toaster>` for sonner-based toast notifications (theme-aware via CSS variable hooks)
- Tailwind CSS globals import pointing to aliased theme tokens
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

Run `audit_theme` to verify that no new hard-coded colors are introduced outside the theme directory:

```bash
pnpm audit_theme
```

This checks:

- No hex/rgb/hsl color literals in `frontend/**` (outside `theme/`)
- All CSS variables in `globals.css` are aliased onto theme tokens
- Tailwind config references theme tokens instead of hard-coded values

## Future Enhancements

- Consider extracting form-related compound components (`FormField`, `FormLabel`, etc.) into the library if used widely
- Evaluate whether chart-specific colors in TokenUsagePanel should be parameterized from the theme or kept as a special case for CVD accessibility
- Maintain the library as new screens are added to the app
