import type { ThemeDefinition } from '../themes/presets.js';

export type DeckMode = 'light' | 'dark';

/** What the renderer and the editor's previews draw with, from a Riff theme in one mode. Colors are #rrggbb. */
export interface DeckStyle {
  bg: string;
  surface: string;
  surfaceMuted: string;
  border: string;
  text: string;
  textMuted: string;
  primary: string;
  onPrimary: string;
  headingFont: string;
  bodyFont: string;
}

const GENERIC = new Set([
  'ui-sans-serif', 'ui-serif', 'ui-monospace', 'system-ui', '-apple-system', 'blinkmacsystemfont',
  'sans-serif', 'serif', 'monospace', 'segoe ui', 'roboto', 'helvetica neue', 'arial',
]);

/** The first named family of a CSS font stack, or Calibri when the stack is only system fonts. */
export function firstFamily(stack: string): string {
  for (const part of stack.split(',')) {
    const name = part.trim().replace(/^["']|["']$/g, '');
    if (name && !GENERIC.has(name.toLowerCase())) return name;
  }
  return 'Calibri';
}

/** Slides default to sans-serif: a heading stack that falls back to a serif family uses the body font instead. */
export function slideHeadingFamily(headingStack: string, sansStack: string): string {
  const last = headingStack.split(',').pop()?.trim().toLowerCase();
  return last === 'serif' || last === 'ui-serif' ? firstFamily(sansStack) : firstFamily(headingStack);
}

export function deckStyle(theme: ThemeDefinition, mode: DeckMode): DeckStyle {
  const c = theme[mode];
  return {
    bg: c.bg,
    surface: c.surface,
    surfaceMuted: c.surfaceMuted,
    border: c.border,
    text: c.text,
    textMuted: c.textMuted,
    primary: c.primary,
    onPrimary: c.onPrimary,
    headingFont: slideHeadingFamily(theme.fonts.heading, theme.fonts.sans),
    bodyFont: firstFamily(theme.fonts.sans),
  };
}
