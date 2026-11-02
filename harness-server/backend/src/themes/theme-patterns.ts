// The page patterns an app's screens are composed from. They are the same
// layout the theme preview in Riff shows (frontend ThemeShowcase), so what a
// human approves in the picker is what the agents build. Written into
// docs/theme.md by renderThemeDoc.

export const PATTERNS_HEADING = 'Page patterns';

export function renderPagePatterns(): string {
  return `## ${PATTERNS_HEADING}

Build every screen by composing these, not by inventing layouts. They show what the theme looks like in use: spacing comes from
\`ui-stack\` / \`ui-row\` and the \`--space-*\` tokens, hierarchy from one primary action per view, and every status from a badge or
alert tone. Swap the wording and fields; keep the structure.

**Page header.** Title and one muted line on the left, actions on the right: ghost for the least important, secondary next, the single
primary last. Tabs go straight under it when the page has sections.

\`\`\`html
<nav class="ui-nav"><span class="ui-nav__brand">Acme</span><a class="ui-nav__link" aria-current="page">Customers</a>
  <span class="ui-row" style="margin-left:auto"><span class="ui-badge ui-badge--primary">Pro</span><span class="ui-avatar">RI</span></span></nav>
<div class="ui-stack" style="padding: var(--space-6)">
  <div class="ui-row" style="justify-content: space-between">
    <div><h2 class="ui-heading" style="margin:0;font-size:var(--font-size-xl)">Customers</h2>
      <div class="ui-muted" style="font-size:var(--font-size-sm)">Manage accounts, plans and invitations.</div></div>
    <div class="ui-row"><button class="ui-btn ui-btn--ghost">Export</button><button class="ui-btn ui-btn--secondary">Import</button><button class="ui-btn">New customer</button></div>
  </div>
  <div role="tablist" class="ui-tabs"><button role="tab" class="ui-tab" aria-selected="true">Overview</button><button role="tab" class="ui-tab" aria-selected="false">Activity</button></div>
</div>
\`\`\`

**Form card.** Header with title and a status badge, body of labelled fields in a \`ui-stack\`, footer with Cancel (secondary) then the
primary action. A hint under a field says what it's for; an invalid field gets \`aria-invalid="true"\` and a \`ui-hint--error\` that says
how to fix it. Checkboxes, radios and switches use \`ui-choice\` rows.

\`\`\`html
<div class="ui-card">
  <div class="ui-card__header"><h3 class="ui-card__title">Invite a teammate</h3><span class="ui-badge">Draft</span></div>
  <div class="ui-card__body ui-stack">
    <label class="ui-field"><span class="ui-label">Email</span><input class="ui-input" type="email" /><span class="ui-hint">We'll send them a sign-in link.</span></label>
    <label class="ui-field"><span class="ui-label">Team code</span><input class="ui-input" aria-invalid="true" /><span class="ui-hint ui-hint--error">That code has expired.</span></label>
    <label class="ui-choice"><input class="ui-switch" type="checkbox" role="switch" /> Require two-factor sign-in</label>
  </div>
  <div class="ui-card__footer"><button class="ui-btn ui-btn--secondary">Cancel</button><button class="ui-btn">Send invite</button></div>
</div>
\`\`\`

**Feedback.** One \`ui-alert\` per message, with a short title and the next step, in the tone that matches (\`info\`, \`success\`,
\`warning\`, \`danger\`). Stack them with \`ui-stack\`; never color text by hand.

\`\`\`html
<div class="ui-alert ui-alert--warning"><span class="ui-alert__title">Seats running low</span>2 of 25 seats left on this plan.</div>
\`\`\`

**Data table.** A table inside a \`ui-card\`. First column is the name, with a \`ui-avatar\` when the row is a person or account; status is a
badge tone; secondary columns are \`ui-muted\`; numbers are right-aligned. Destructive row actions use \`ui-btn--danger\` and sit last.

\`\`\`html
<div class="ui-card"><table class="ui-table">
  <thead><tr><th>Customer</th><th>Status</th><th>Plan</th><th style="text-align:right">Seats</th></tr></thead>
  <tbody><tr><td><span class="ui-row" style="gap:var(--space-2)"><span class="ui-avatar">NT</span>Northwind Traders</span></td>
    <td><span class="ui-badge ui-badge--success">Active</span></td><td class="ui-muted">Enterprise</td><td style="text-align:right">120</td></tr></tbody>
</table></div>
\`\`\`

**Layout.** Page content sits in a \`ui-stack\`; a form and its related feedback go side by side from a wide breakpoint
(\`grid\` of two columns with \`gap: var(--space-4)\`) and stack on a phone. Small buttons (\`ui-btn--sm\`) for in-row actions, default size
for page actions. Empty, loading and error states reuse a card or alert, not blank space.
`;
}
