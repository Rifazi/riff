# House style: atmospheric depth, built on the theme

This is how a UI/UX pass makes an app look and feel. It is a way of building, not a palette: the app's theme (`theme/theme.json`, tokens and `ui-*` components) supplies every color, font, radius, border width, shadow and density, so the same style works on any theme, light or dark, and swapping the theme restyles the app. Never hard-code a value the theme has a token for, and never pin a mode: the app follows the OS color scheme unless it already pins one.

The personality: calm, premium, spacious, focused. Depth comes from layers of surface, soft ambient light and restraint, not from color saturation or heavy ornament. Think Linear, Raycast, Arc.

## 1. Layers, not boxes
- Every view uses at least three distinct surface levels from the theme: page `--color-bg`, panels `--color-surface`, raised or inset areas `--color-surface-muted`. Each step is visible but subtle. If a theme's three levels are nearly the same, that is a theme problem: measure with `analyze_colors` and call `propose_theme`, don't paint over it.
- One separation device per level: a border, or a fill step, or a shadow, not all three.
- Borders are quiet: `var(--border-width)` solid `--color-border`, or `color-mix(in srgb, var(--color-text) 10%, transparent)` over a glass surface. Never a heavy outline.
- Elevation: on dark themes lighter surfaces and borders carry it and shadows stay soft; on light themes use `--shadow-sm` / `--shadow-md`. Never invent a shadow color.

## 2. One accent, used sparingly
The accent is `--color-primary` (and its derived `--color-primary-hover`, `--color-primary-soft`, `--focus-ring`). It marks the one primary action per view, the selected item, links, focus and the single highlighted card. It is never used for large fills or decoration. Status colors keep their meaning (`--color-success|warning|danger|info`). Whatever the primary's hue is, that is the glow's hue: amber on one theme, blue on another.

## 3. Ambient light (glow and orbs)
All light is the primary mixed with transparency, so it follows the theme:
- **Glow** (hover, focus, highlighted card, status dot): `box-shadow: 0 0 20px color-mix(in srgb, var(--color-primary) 35%, transparent)`; larger and fainter (40-60px, 15-25%) for a featured card; a border glow is `0 0 0 1px color-mix(in srgb, var(--color-primary) 30%, transparent)` plus the soft glow. Glow is a reward for interaction or the one focal element, never resting decoration on many things. On light themes cut it to roughly half; it should read as warmth, not a halo.
- **Ambient orbs**: at most two blurred circles (`filter: blur(100px+)`, `color-mix(in srgb, var(--color-primary) 4%, transparent)`, `position: fixed`, `pointer-events: none`, `aria-hidden`, behind content), defined once in the app shell, not per view. Smaller on phone. They are atmosphere: remove them before sacrificing legibility or performance.
- A pulsing status dot (the live/online badge) uses `animate-pulse`-style opacity only, with the glow.

## 4. Glass cards
For cards and inputs that sit over the atmosphere:
```css
background: color-mix(in srgb, var(--color-surface) 60%, transparent);
backdrop-filter: blur(8px);
border: var(--border-width) solid color-mix(in srgb, var(--color-text) 10%, transparent);
border-radius: var(--radius-lg);
```
- Always provide a solid fallback (`@supports not (backdrop-filter: blur(1px))` → plain `--color-surface`) and check that text still meets 4.5:1 on the solid surface, since that is the worst case.
- Glass only floats over something: use it on views with the ambient backdrop. Dense data tables, forms and dialogs stay on solid surfaces; legibility beats effect.
- Prefer the theme's `ui-card` and add the glass as a modifier in the app's own stylesheet. Do not fork the component.

## 5. Type through the tokens
- Display and headings use `--font-heading` at `--font-weight-heading`, tight tracking (`-0.025em`), line height 1.1-1.3. Body uses `--font-sans`; labels, metadata, code and numbers in tables use `--font-mono` or tabular figures, with a little positive tracking on short uppercase labels.
- Sizes come from `--font-size-xs|sm|base|lg|xl`; a bigger hero heading may scale above `xl` with `clamp()` between them. At most six sizes on a screen. Hierarchy through size and weight first, then color: text, then `--color-text-muted` for metadata.
- Never import or name a font the theme doesn't define. If the look needs a different typeface, that is a theme change.

## 6. Space and density
- Space comes from `--space-*`. Related things sit closer than unrelated ones; the gap between groups is at least double the gap inside one; padding inside a card is larger than the gap between cards.
- Breathing room follows the job: landing, onboarding, empty and settings views are airy (large vertical section padding, content in a max-width container, `max-w-6xl` or the repo's equivalent, gutters that grow with width). Data tools (tables, lists, consoles) keep the theme's density. A `compact` theme stays compact; the style never overrides it.
- Grids stay simple: 1 column on phone, 2-3 on desktop, a consistent gap. Stack, reorder and collapse at phone width; never a squeezed desktop.

## 7. Motion and micro-interactions
- 200ms `ease-out` for buttons, links, inputs; 300ms for cards and disclosures. Animate opacity, transform, border-color, box-shadow and background only.
- Interactive card hover: border brightens, shadow or glow rises, `scale(1.02)` at most. Button press: `scale(0.98)`. Hover effects that matter also apply on `:active` / `:focus-visible` so touch and keyboard get them.
- Accordions and disclosures animate height and opacity together. No bounce, no dramatic transforms, nothing that loops except the status pulse.
- Every transform and animation sits behind `@media (prefers-reduced-motion: no-preference)`; with reduced motion the state still changes, just instantly.

## 8. Focus, contrast, touch
- Focus uses the theme's `--focus-ring` on every interactive element (`:focus-visible`), the same ring everywhere: buttons, links, inputs, tabs, cards that are links. Links gain `--color-primary` on focus-visible. An input's focus is the primary border plus the ring and a faint glow.
- Primary text on bg and surface is at least 4.5:1, muted text at least 4.5:1 on every surface it sits on, icons and borders that carry meaning at least 3:1, in both modes. Check glass surfaces on their fallback.
- Touch targets are at least 44px: use `--control-height` where it is, and pad up icon-only controls to 44px with an accessible name.
- Icons: thin strokes (1.5), `currentColor`, muted by default and `--color-primary` only for the active or accent state; use the icon set the repo already has.

## Where the code lives
- Build from `ui-*` components and tokens first. What the catalog lacks (glass modifier, glow, orbs, hero layout) goes in one app-owned stylesheet imported after `theme/index.css`, using classes under the app's own prefix (never `ui-`, which is the theme's) and only `var(--…)` and `color-mix()` of tokens. Check the repo's existing pattern first (CSS modules, Tailwind with the tokens mapped, a styles folder) and follow it; with Tailwind, map the effects through the existing token-based config, not arbitrary hex values.
- Reuse these definitions across views. Two views that need the same effect share one class; do not paste the recipe.
- Run `audit_theme` before finishing a view: no new hard-coded colors, no tokens that shadow the theme's. Never edit `theme/` or `docs/theme.md`.

## What this style is not
Pure black or pure white; harsh high contrast; saturated or rainbow color; cold and sterile; flat with no depth; glow and glass on everything; a dark mode that is the light mode inverted; effects that cost legibility, accessibility or phone performance.

## For the UI/UX lead: judging against this style
When you audit a screen, add these checks to the 12 signs: fewer than three visible surface levels; the accent spent on more than one thing per view; glow or glass at rest on dense content; a card with border, shadow and fill together; a hero without breathing room next to cramped data; an interactive element without the shared focus ring or hover/press response; motion without a reduced-motion guard. Write requirements in terms of tokens and roles ("the plan card is a glass card, the Upgrade button is the only primary action and gains the glow on hover"), never hex values, so they hold on whichever theme the app has. If the theme can't carry the style (three surfaces within a few lightness points, a primary too weak for a glow, muted text under 4.5:1), say so with the measurement and `propose_theme`.
