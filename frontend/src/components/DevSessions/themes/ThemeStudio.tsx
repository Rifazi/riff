'use client';

import { useState } from 'react';
import { Ban } from 'lucide-react';
import type { ThemeDraft, ThemeMode, ThemeTokens } from '@/lib/dev-sessions/types';
import { ErrorText, LoadingState, Pill } from '../PageShell';
import { ModeToggle } from './ModeToggle';
import { ThemeEditor } from './ThemeEditor';
import { ThemeShowcase } from './ThemeShowcase';
import { ThemeTile } from './ThemeTile';
import { useThemes, useThemeTokens } from './ThemeFrame';
import { sameTheme } from './theme-utils';

const CURRENT = 'current';

/**
 * Pick a theme by what it looks like, then edit it with a live preview of
 * the main components. Controlled: the parent owns the draft and decides
 * what saving means (an app's Theme page, a new app, a requirements
 * proposal). `value` null means "no theme" (only offered with allowNone).
 */
export function ThemeStudio({
  value,
  onChange,
  current = null,
  appName,
  allowNone = false,
}: {
  value: ThemeDraft | null;
  onChange: (draft: ThemeDraft | null) => void;
  // The app's saved theme, offered as a starting point next to the presets.
  current?: (ThemeDraft & { tokens: ThemeTokens }) | null;
  appName?: string;
  allowNone?: boolean;
}) {
  const { data, isLoading, error } = useThemes();
  const [mode, setMode] = useState<ThemeMode>('light');
  const { tokens, error: previewError } = useThemeTokens(value?.theme ?? null);

  if (isLoading) return <LoadingState label="Loading themes…" />;
  if (error || !data) return <ErrorText>Couldn&apos;t load themes: {(error as Error | null)?.message ?? 'no response'}</ErrorText>;

  // Which starting point the draft came from; "Edited" once it differs.
  const matches = (key: string) => {
    if (!value) return false;
    if (key === CURRENT) return Boolean(current && sameTheme(current.theme, value.theme));
    const preset = data.presets.find((p) => p.id === key);
    return Boolean(preset && sameTheme(preset.theme, value.theme));
  };
  const exact = [CURRENT, ...data.presets.map((p) => p.id)].find(matches);
  const origin = exact ?? (current && value?.basedOn === current.basedOn ? CURRENT : (value?.basedOn ?? null));
  const edited = Boolean(value) && !exact;

  const badgeFor = (key: string) =>
    key === origin && edited ? <Pill tone="amber">Edited</Pill> : key === CURRENT ? <Pill tone="green">Current</Pill> : null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="text-xs text-gray-500">
          Start from the current theme or a preset, then adjust anything. The result is saved to the app&apos;s <code>theme/theme.json</code>.
        </div>
        <ModeToggle mode={mode} onChange={setMode} />
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {allowNone && (
          <button
            type="button"
            onClick={() => onChange(null)}
            aria-pressed={value === null}
            className={`flex flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed p-4 text-sm ${
              value === null ? 'border-blue-500 ring-2 ring-blue-500/30 text-gray-900' : 'border-gray-300 text-gray-500 hover:bg-white'
            }`}
          >
            <Ban className="h-5 w-5" />
            No theme for now
          </button>
        )}
        {current && (
          <ThemeTile
            theme={current.theme}
            tokens={current.tokens}
            mode={mode}
            selected={origin === CURRENT}
            badge={badgeFor(CURRENT)}
            onSelect={() => onChange({ theme: current.theme, basedOn: current.basedOn })}
          />
        )}
        {data.presets.map((preset) => (
          <ThemeTile
            key={preset.id}
            theme={preset.theme}
            tokens={preset.tokens}
            mode={mode}
            selected={origin === preset.id}
            badge={badgeFor(preset.id)}
            onSelect={() => onChange({ theme: preset.theme, basedOn: preset.id })}
          />
        ))}
      </div>

      {value && (
        <div className="grid grid-cols-1 lg:grid-cols-[340px_minmax(0,1fr)] gap-4 items-start">
          <div className="rounded-lg border border-gray-200 bg-white p-3 lg:sticky lg:top-0 lg:max-h-[calc(100vh-12rem)] overflow-y-auto custom-scrollbar">
            <ThemeEditor theme={value.theme} mode={mode} onChange={(theme) => onChange({ ...value, theme })} />
          </div>
          <div className="space-y-2 min-w-0">
            {previewError && <ErrorText>{previewError}</ErrorText>}
            <ThemeShowcase tokens={tokens} mode={mode} appName={appName} />
          </div>
        </div>
      )}
    </div>
  );
}
