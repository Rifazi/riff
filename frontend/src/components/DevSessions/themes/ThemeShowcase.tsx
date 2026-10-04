'use client';

import { useId, useState } from 'react';
import type { ThemeMode, ThemeTokens } from '@/lib/dev-sessions/types';
import { ThemeFrame } from './ThemeFrame';

// A sample screen built only from the generated ui-* classes, so it shows
// exactly what an app gets from the theme. Tailwind classes here are for
// the sample's own layout only, never for its look.

const TABS = ['Overview', 'Activity', 'Settings'];
const TONES = ['info', 'success', 'warning', 'danger'] as const;
const ALERTS: Record<(typeof TONES)[number], [string, string]> = {
  info: ['Syncing', 'Customer data refreshes every 15 minutes.'],
  success: ['Invite sent', 'Maya will get an email shortly.'],
  warning: ['Seats running low', '2 of 25 seats left on this plan.'],
  danger: ['Payment failed', 'Update the card on file to keep access.'],
};
const ROWS = [
  { name: 'Northwind Traders', initials: 'NT', status: ['Active', 'success'], plan: 'Enterprise', seats: 120 },
  { name: 'Globex Corp', initials: 'GC', status: ['Trial', 'info'], plan: 'Pro', seats: 18 },
  { name: 'Initech', initials: 'IN', status: ['Past due', 'warning'], plan: 'Pro', seats: 42 },
  { name: 'Umbrella Health', initials: 'UH', status: ['Cancelled', 'danger'], plan: 'Starter', seats: 5 },
];

const noNav = (e: React.MouseEvent) => e.preventDefault();

export function ThemeShowcase({
  tokens,
  mode,
  appName = 'Acme',
}: {
  tokens: ThemeTokens | undefined;
  mode: ThemeMode;
  appName?: string;
}) {
  const [tab, setTab] = useState(TABS[0]);
  const radioGroup = useId();

  return (
    <ThemeFrame tokens={tokens} mode={mode} className="rounded-lg overflow-hidden border border-border min-h-[400px]">
      <nav className="ui-nav">
        <span className="ui-nav__brand">{appName}</span>
        {['Dashboard', 'Customers', 'Reports'].map((label) => (
          <a
            key={label}
            href="#"
            onClick={noNav}
            className="ui-nav__link"
            aria-current={label === 'Customers' ? 'page' : undefined}
          >
            {label}
          </a>
        ))}
        <span className="ui-row" style={{ marginLeft: 'auto' }}>
          <span className="ui-badge ui-badge--primary">Pro</span>
          <span className="ui-avatar">RI</span>
        </span>
      </nav>

      <div className="ui-stack" style={{ padding: 'var(--space-6)' }}>
        <div className="ui-row" style={{ justifyContent: 'space-between' }}>
          <div>
            <h2 className="ui-heading" style={{ margin: 0, fontSize: 'var(--font-size-xl)' }}>
              Customers
            </h2>
            <div className="ui-muted" style={{ fontSize: 'var(--font-size-sm)' }}>
              Manage accounts, plans and invitations.
            </div>
          </div>
          <div className="ui-row">
            <button className="ui-btn ui-btn--ghost">Export</button>
            <button className="ui-btn ui-btn--secondary">Import</button>
            <button className="ui-btn">New customer</button>
          </div>
        </div>

        <div role="tablist" className="ui-tabs">
          {TABS.map((label) => (
            <button
              key={label}
              role="tab"
              className="ui-tab"
              aria-selected={tab === label}
              onClick={() => setTab(label)}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-2 items-start" style={{ gap: 'var(--space-4)' }}>
          <div className="ui-card">
            <div className="ui-card__header">
              <h3 className="ui-card__title">Invite a teammate</h3>
              <span className="ui-badge">Draft</span>
            </div>
            <div className="ui-card__body ui-stack">
              <label className="ui-field">
                <span className="ui-label">Email</span>
                <input className="ui-input" type="email" placeholder="maya@example.com" />
                <span className="ui-hint">We&apos;ll send them a sign-in link.</span>
              </label>
              <label className="ui-field">
                <span className="ui-label">Role</span>
                <select className="ui-select" defaultValue="editor">
                  <option value="viewer">Viewer</option>
                  <option value="editor">Editor</option>
                  <option value="admin">Admin</option>
                </select>
              </label>
              <label className="ui-field">
                <span className="ui-label">Team code</span>
                <input className="ui-input" defaultValue="ACME-12" aria-invalid="true" />
                <span className="ui-hint ui-hint--error">That code has expired.</span>
              </label>
              <label className="ui-field">
                <span className="ui-label">Message</span>
                <textarea className="ui-textarea" placeholder="Add a note (optional)" />
              </label>
              <div className="ui-row">
                <label className="ui-choice">
                  <input className="ui-check" type="checkbox" defaultChecked /> Copy me
                </label>
                <label className="ui-choice">
                  <input className="ui-check" type="radio" name={radioGroup} defaultChecked /> All projects
                </label>
                <label className="ui-choice">
                  <input className="ui-check" type="radio" name={radioGroup} /> Selected
                </label>
              </div>
              <label className="ui-choice">
                <input className="ui-switch" type="checkbox" role="switch" defaultChecked /> Require two-factor sign-in
              </label>
            </div>
            <div className="ui-card__footer">
              <button className="ui-btn ui-btn--secondary">Cancel</button>
              <button className="ui-btn">Send invite</button>
            </div>
          </div>

          <div className="ui-stack">
            {TONES.map((tone) => (
              <div key={tone} className={`ui-alert ui-alert--${tone}`}>
                <span className="ui-alert__title">{ALERTS[tone][0]}</span>
                {ALERTS[tone][1]}
              </div>
            ))}
            <div className="ui-card">
              <div className="ui-card__body ui-stack">
                <div className="ui-row">
                  <span className="ui-badge">Neutral</span>
                  {(['primary', ...TONES] as const).map((tone) => (
                    <span key={tone} className={`ui-badge ui-badge--${tone}`}>
                      {tone[0].toUpperCase() + tone.slice(1)}
                    </span>
                  ))}
                </div>
                <div className="ui-row">
                  <button className="ui-btn ui-btn--sm">Small</button>
                  <button className="ui-btn ui-btn--sm ui-btn--secondary">Secondary</button>
                  <button className="ui-btn ui-btn--sm ui-btn--danger">Delete</button>
                  <button className="ui-btn ui-btn--sm" disabled>
                    Disabled
                  </button>
                </div>
                <p className="ui-muted" style={{ margin: 0, fontSize: 'var(--font-size-sm)' }}>
                  Secondary text with an{' '}
                  <a href="#" onClick={noNav} className="ui-link">
                    inline link
                  </a>{' '}
                  and <code>inline code</code>.
                </p>
              </div>
            </div>
          </div>
        </div>

        <div className="ui-card">
          <table className="ui-table">
            <thead>
              <tr>
                <th>Customer</th>
                <th>Status</th>
                <th>Plan</th>
                <th style={{ textAlign: 'right' }}>Seats</th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map((row) => (
                <tr key={row.name}>
                  <td>
                    <span className="ui-row" style={{ gap: 'var(--space-2)' }}>
                      <span className="ui-avatar">{row.initials}</span>
                      {row.name}
                    </span>
                  </td>
                  <td>
                    <span className={`ui-badge ui-badge--${row.status[1]}`}>{row.status[0]}</span>
                  </td>
                  <td className="ui-muted">{row.plan}</td>
                  <td style={{ textAlign: 'right' }}>{row.seats}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </ThemeFrame>
  );
}
