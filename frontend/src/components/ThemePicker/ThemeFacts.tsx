'use client';

import type { ThemeColors, ThemeDefinition, ThemeMode } from '@/lib/dev-sessions/types';

const COLOR_LABELS: [keyof ThemeColors, string][] = [
  ['bg', 'Background'],
  ['surface', 'Surface'],
  ['surfaceMuted', 'Muted surface'],
  ['border', 'Border'],
  ['text', 'Text'],
  ['textMuted', 'Muted text'],
  ['primary', 'Primary'],
  ['onPrimary', 'On primary'],
  ['success', 'Success'],
  ['warning', 'Warning'],
  ['danger', 'Danger'],
  ['info', 'Info'],
];

const family = (stack: string) => stack.split(',')[0].trim().replace(/^["']|["']$/g, '');

/** Everything about a theme that a preview doesn't show directly: every color with its hex, fonts, shape and density. */
export function ThemeFacts({ theme, mode }: { theme: ThemeDefinition; mode: ThemeMode }) {
  const colors = theme[mode];
  const facts: [string, string][] = [
    ['Heading font', `${family(theme.fonts.heading)} · ${theme.headingWeight}`],
    ['Body font', family(theme.fonts.sans)],
    ['Mono font', family(theme.fonts.mono)],
    ['Corners', theme.radius.md === 0 ? 'Square' : `${theme.radius.sm} / ${theme.radius.md} / ${theme.radius.lg}px`],
    ['Borders', `${theme.borderWidth}px`],
    ['Density', theme.density],
  ];
  return (
    <div className="space-y-4">
      <div>
        <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Palette</div>
        <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-2">
          {COLOR_LABELS.map(([key, label]) => (
            <div key={key} className="min-w-0">
              <div className="h-8 rounded-md border border-border" style={{ background: colors[key] }} />
              <div className="mt-1 truncate text-[11px] text-foreground">{label}</div>
              <div className="font-mono text-[10px] uppercase text-muted-foreground">{colors[key]}</div>
            </div>
          ))}
        </div>
      </div>
      <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2 text-xs">
        {facts.map(([k, v]) => (
          <div key={k} className="min-w-0">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="truncate capitalize text-foreground">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
