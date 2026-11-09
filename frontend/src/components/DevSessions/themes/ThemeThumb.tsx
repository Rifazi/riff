'use client';

import type { ThemeDefinition, ThemeMode, ThemeTokens } from '@/lib/dev-sessions/types';
import { ThemeFrame } from './ThemeFrame';

/** A miniature of a theme applied, zoomed down so it all fits a chip: nav, a card with a heading and text, buttons and a badge. */
export function ThemeThumb({
  theme,
  tokens,
  mode,
}: {
  theme: ThemeDefinition;
  tokens: ThemeTokens | undefined;
  mode: ThemeMode;
}) {
  return (
    <ThemeFrame tokens={tokens} mode={mode} className="h-[104px] overflow-hidden">
      <div style={{ zoom: 0.62 }}>
        <div className="ui-nav" style={{ minHeight: 0, padding: 'var(--space-2) var(--space-3)' }}>
          <span className="ui-nav__brand" style={{ fontSize: 'var(--font-size-sm)' }}>
            {theme.name}
          </span>
          <span className="ui-avatar" style={{ marginLeft: 'auto', width: 20, height: 20 }}>
            A
          </span>
        </div>
        <div className="ui-stack" style={{ padding: 'var(--space-3)', gap: 'var(--space-2)' }}>
          <div className="ui-card" style={{ padding: 'var(--space-2) var(--space-3)' }}>
            <div className="ui-heading" style={{ fontSize: 'var(--font-size-sm)', margin: 0 }}>
              Invoices
            </div>
            <div className="ui-muted" style={{ fontSize: 'var(--font-size-xs)' }}>
              3 awaiting approval
            </div>
          </div>
          <div className="ui-row" style={{ gap: 'var(--space-2)' }}>
            <span className="ui-btn ui-btn--sm">Approve</span>
            <span className="ui-btn ui-btn--sm ui-btn--secondary">Skip</span>
            <span className="ui-badge ui-badge--success">Paid</span>
            <span className="ui-badge ui-badge--danger">Late</span>
          </div>
        </div>
      </div>
    </ThemeFrame>
  );
}
