import type { ThemeDefinition, ThemeMode } from '@/lib/dev-sessions/types';
import type { DeckSlide, DeckStyle } from './api';

const GENERIC = new Set([
  'ui-sans-serif', 'ui-serif', 'ui-monospace', 'system-ui', '-apple-system', 'blinkmacsystemfont',
  'sans-serif', 'serif', 'monospace', 'segoe ui', 'roboto', 'helvetica neue', 'arial',
]);

const firstFamily = (stack: string) => {
  for (const part of stack.split(',')) {
    const name = part.trim().replace(/^["']|["']$/g, '');
    if (name && !GENERIC.has(name.toLowerCase())) return name;
  }
  return 'Calibri';
};

/** What the server's deckStyle returns for a theme, so a deck can be previewed before it is drawn. */
export function deckStyleFor(theme: ThemeDefinition, mode: ThemeMode): DeckStyle {
  const { bg, surface, surfaceMuted, border, text, textMuted, primary, onPrimary } = theme[mode];
  return {
    bg, surface, surfaceMuted, border, text, textMuted, primary, onPrimary,
    headingFont: firstFamily(theme.fonts.heading),
    bodyFont: firstFamily(theme.fonts.sans),
  };
}

export const SAMPLE_SLIDES: DeckSlide[] = [
  { layout: 'title', title: 'Quarterly review', subtitle: 'What shipped, what changed, what is next' },
  { layout: 'bullets', title: 'Highlights', bullets: ['Launch moved up two weeks', 'Support load down 18%', 'Three new integrations live'] },
  { layout: 'two_column', title: 'Before and after', left: { heading: 'Before', bullets: ['Manual hand-offs', 'Weekly reports'] }, right: { heading: 'After', bullets: ['Automated routing', 'Live dashboards'] } },
  { layout: 'stat', title: 'By the numbers', stats: [{ value: '42%', label: 'Faster' }, { value: '1.2k', label: 'Users' }, { value: '99.9%', label: 'Uptime' }] },
  { layout: 'quote', quote: 'The best way to predict the future is to build it.', attribution: 'Alan Kay' },
  { layout: 'closing', title: 'Next steps', bullets: ['Confirm scope', 'Assign owners'] },
];
