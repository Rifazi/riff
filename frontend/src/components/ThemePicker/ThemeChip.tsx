'use client';

import { Check } from 'lucide-react';
import type { ThemeMode } from '@/lib/dev-sessions/types';
import type { ThemeOption } from './types';

/** The compact form of a theme: a wide palette band over its name. Click to open the full preview. */
export function ThemeChip({
  option,
  mode,
  selected,
  onOpen,
  thumb,
}: {
  option: ThemeOption;
  mode: ThemeMode;
  selected: boolean;
  onOpen: () => void;
  // A miniature of the theme applied; the palette band is the fallback.
  thumb?: React.ReactNode;
}) {
  const { theme, badge } = option;
  const c = theme[mode];
  const band = [c.bg, c.surface, c.primary, c.text, c.success, c.warning, c.danger];
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-pressed={selected}
      aria-haspopup="dialog"
      title={theme.description}
      className={`flex flex-col overflow-hidden rounded-lg border bg-card text-left transition-shadow focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
        selected ? 'border-primary ring-2 ring-primary/30' : 'border-border hover:shadow-md'
      }`}
    >
      {thumb && <span className="pointer-events-none block border-b border-border">{thumb}</span>}
      <span className={`flex w-full border-b border-border ${thumb ? 'h-2' : 'h-14'}`} style={{ background: c.bg }}>
        {band.map((color, i) => (
          <span key={i} className="flex-1" style={{ background: color, flexGrow: i === 2 ? 2 : 1 }} />
        ))}
      </span>
      <span className="flex items-center gap-2 px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">{theme.name}</span>
        {badge && <span className="flex-shrink-0">{badge}</span>}
        {selected && <Check className="h-4 w-4 flex-shrink-0 text-primary" />}
      </span>
    </button>
  );
}
