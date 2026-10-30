'use client';

import { useState } from 'react';
import { Ban } from 'lucide-react';
import type { ThemeDraft, ThemeMode, ThemeTokens } from '@/lib/dev-sessions/types';
import { Badge } from '@/components/ui/badge';
import { ErrorText, LoadingState } from '../PageShell';
import { ModeToggle } from './ModeToggle';
import { ThemeEditor } from './ThemeEditor';
import { ThemeShowcase } from './ThemeShowcase';
import { ThemeThumb } from './ThemeThumb';
import { ThemePicker, type ThemeOption } from '@/components/ThemePicker';
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
  if (error || !data)
    return <ErrorText>Couldn&apos;t load themes: {(error as Error | null)?.message ?? 'no response'}</ErrorText>;

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
    key === origin && edited ? (
      <Badge variant="warning">Edited</Badge>
    ) : key === CURRENT ? (
      <Badge variant="success">Current</Badge>
    ) : null;

  const options: ThemeOption[] = [
    ...(current ? [{ id: CURRENT, theme: current.theme, tokens: current.tokens, badge: badgeFor(CURRENT) }] : []),
    ...data.presets.map((p) => ({ id: p.id, theme: p.theme, tokens: p.tokens, badge: badgeFor(p.id) })),
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="text-xs text-muted-foreground">
          Start from the current theme or a preset, then adjust anything. The result is saved to the app&apos;s{' '}
          <code>theme/theme.json</code>.
        </div>
        <ModeToggle mode={mode} onChange={setMode} />
      </div>

      <ThemePicker
        options={options}
        selectedId={origin ?? null}
        mode={mode}
        onModeChange={setMode}
        onSelect={(option) => {
          if (option.id === CURRENT && current) onChange({ theme: current.theme, basedOn: current.basedOn });
          else onChange({ theme: option.theme, basedOn: option.id });
        }}
        renderPreview={({ option, mode }) => <ThemeShowcase tokens={option.tokens} mode={mode} appName={appName} />}
        renderThumb={({ option, mode }) => <ThemeThumb theme={option.theme} tokens={option.tokens} mode={mode} />}
        leading={
          allowNone && (
            <button
              type="button"
              onClick={() => onChange(null)}
              aria-pressed={value === null}
              className={`flex items-center justify-center gap-2 rounded-lg border border-dashed px-2.5 py-2 text-sm ${
                value === null
                  ? 'border-primary ring-2 ring-primary/30 text-foreground'
                  : 'border-border text-muted-foreground hover:bg-muted'
              }`}
            >
              <Ban className="h-4 w-4" />
              No theme for now
            </button>
          )
        }
      />

      {value && (
        <div className="grid grid-cols-1 lg:grid-cols-[340px_minmax(0,1fr)] gap-4 items-start">
          <div className="rounded-lg border border-border bg-card p-3 lg:sticky lg:top-0 lg:max-h-[calc(100vh-12rem)] overflow-y-auto custom-scrollbar">
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
