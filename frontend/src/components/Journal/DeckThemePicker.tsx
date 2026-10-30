'use client';

import { Loader2 } from 'lucide-react';
import type { ThemeMode } from '@/lib/dev-sessions/types';
import { ModeToggle } from '@/components/DevSessions/themes/ModeToggle';
import { ThemeTile } from '@/components/DevSessions/themes/ThemeTile';
import { useThemes } from '@/components/DevSessions/themes/ThemeFrame';

/** The same theme presets as the Theme picker; every slide of the deck is drawn in the one chosen. */
export function DeckThemePicker({
  themeId,
  mode,
  onChange,
  disabled,
}: {
  themeId: string;
  mode: ThemeMode;
  onChange: (themeId: string, mode: ThemeMode) => void;
  disabled?: boolean;
}) {
  const { data, isLoading, error } = useThemes();
  if (isLoading)
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading themes…
      </div>
    );
  if (error || !data) return <div className="text-sm text-destructive">Couldn&apos;t load themes.</div>;

  const selected = themeId || data.presets[0]?.id;
  return (
    <div className={`space-y-2 ${disabled ? 'pointer-events-none opacity-60' : ''}`}>
      <div className="flex justify-end">
        <ModeToggle mode={mode} onChange={(m) => onChange(selected, m)} />
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {data.presets.map((preset) => (
          <ThemeTile
            key={preset.id}
            theme={preset.theme}
            tokens={preset.tokens}
            mode={mode}
            selected={preset.id === selected}
            onSelect={() => onChange(preset.id, mode)}
          />
        ))}
      </div>
    </div>
  );
}
