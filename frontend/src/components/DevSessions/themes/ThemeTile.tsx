'use client';

import type { ThemeDefinition, ThemeMode, ThemeTokens } from '@/lib/dev-sessions/types';
import { ThemeFrame } from './ThemeFrame';
import { swatches } from './theme-utils';

/** A starting-point card: a miniature of the theme's main components, plus its name. */
export function ThemeTile({
  theme,
  tokens,
  mode,
  selected,
  badge,
  onSelect,
}: {
  theme: ThemeDefinition;
  tokens: ThemeTokens | undefined;
  mode: ThemeMode;
  selected: boolean;
  badge?: React.ReactNode;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`flex flex-col text-left rounded-lg border bg-white overflow-hidden transition-shadow focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
        selected ? 'border-blue-500 ring-2 ring-blue-500/30 shadow-md' : 'border-gray-200 hover:shadow-md'
      }`}
    >
      <ThemeFrame tokens={tokens} mode={mode} className="pointer-events-none flex-1 min-h-[112px]">
        <div className="ui-nav" style={{ minHeight: 0, padding: 'var(--space-2) var(--space-3)' }}>
          <span className="ui-nav__brand" style={{ fontSize: 'var(--font-size-sm)' }}>
            {theme.name}
          </span>
          <span className="ui-avatar" style={{ marginLeft: 'auto', width: 20, height: 20 }}>
            A
          </span>
        </div>
        <div className="ui-row" style={{ padding: 'var(--space-3)', gap: 'var(--space-2)' }}>
          <span className="ui-btn ui-btn--sm">Save</span>
          <span className="ui-btn ui-btn--sm ui-btn--secondary">Cancel</span>
          <span className="ui-badge ui-badge--success">Active</span>
        </div>
      </ThemeFrame>
      <div className="px-3 py-2 border-t border-gray-100">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-gray-900 truncate">{theme.name}</span>
          <span className="flex -space-x-1 flex-shrink-0">
            {swatches(theme, mode).map((color, i) => (
              <span key={i} className="h-3 w-3 rounded-full border border-white shadow-sm" style={{ background: color }} />
            ))}
          </span>
          {badge && <span className="ml-auto flex-shrink-0">{badge}</span>}
        </div>
        <p className="mt-0.5 text-xs text-gray-500 line-clamp-3">{theme.description}</p>
      </div>
    </button>
  );
}
