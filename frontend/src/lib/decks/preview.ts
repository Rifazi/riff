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

/** Slides default to sans-serif: a heading stack that falls back to a serif family uses the body font instead. */
const slideHeadingFamily = (headingStack: string, sansStack: string) => {
  const last = headingStack.split(',').pop()?.trim().toLowerCase();
  return last === 'serif' || last === 'ui-serif' ? firstFamily(sansStack) : firstFamily(headingStack);
};

/** What the server's deckStyle returns for a theme, so a deck can be previewed before it is drawn. */
export function deckStyleFor(theme: ThemeDefinition, mode: ThemeMode): DeckStyle {
  const { bg, surface, surfaceMuted, border, text, textMuted, primary, onPrimary } = theme[mode];
  return {
    bg, surface, surfaceMuted, border, text, textMuted, primary, onPrimary,
    headingFont: slideHeadingFamily(theme.fonts.heading, theme.fonts.sans),
    bodyFont: firstFamily(theme.fonts.sans),
  };
}

export const SAMPLE_SLIDES: DeckSlide[] = [
  { layout: 'title', title: 'Quarterly review', subtitle: 'What shipped, what changed, what is next' },
  { layout: 'bullets', title: 'Highlights', bullets: ['Launch moved up two weeks', 'Support load down 18%', 'Three new integrations live'] },
  { layout: 'two_column', title: 'Before and after', left: { heading: 'Before', bullets: ['Manual hand-offs', 'Weekly reports'] }, right: { heading: 'After', bullets: ['Automated routing', 'Live dashboards'] } },
  { layout: 'stat', title: 'By the numbers', stats: [{ value: '42%', label: 'Faster' }, { value: '1.2k', label: 'Users' }, { value: '99.9%', label: 'Uptime' }] },
  { layout: 'timeline', title: 'Three milestones', events: [{ when: 'Mar 4', label: 'Kickoff' }, { when: 'Apr 18', label: 'Beta' }, { when: 'Jun 2', label: 'Launch' }] },
  { layout: 'bar_chart', title: 'Support load fell most in billing', items: [{ label: 'Billing', value: 38, display: '38%' }, { label: 'Setup', value: 21, display: '21%' }, { label: 'Reports', value: 9, display: '9%' }] },
  { layout: 'status_list', title: 'Two items left', items: [{ label: 'Migrate accounts', status: 'done' }, { label: 'Sign off pricing', status: 'open' }, { label: 'Vendor delay', status: 'risk' }] },
  { layout: 'statement', statement: 'We ship the smaller version first.' },
  { layout: 'quote', quote: 'The best way to predict the future is to build it.', attribution: 'Alan Kay' },
  { layout: 'closing', title: 'Next steps', bullets: ['Confirm scope', 'Assign owners'] },
];
