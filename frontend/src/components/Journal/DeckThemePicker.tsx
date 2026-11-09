'use client';

import { Loader2 } from 'lucide-react';
import type { ThemeMode } from '@/lib/dev-sessions/types';
import { useThemes } from '@/components/DevSessions/themes/ThemeFrame';
import { ThemePicker, type ThemeOption } from '@/components/ThemePicker';
import { deckStyleFor, SAMPLE_SLIDES } from '@/lib/decks/preview';
import { SlidePreview } from './SlidePreview';

/** The same theme presets as the Theme picker, previewed as slides; every slide of the deck is drawn in the one chosen. */
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
  const options: ThemeOption[] = data.presets.map((p) => ({ id: p.id, theme: p.theme, tokens: p.tokens }));

  return (
    <div className={disabled ? 'pointer-events-none opacity-60' : ''}>
      <ThemePicker
        options={options}
        selectedId={selected}
        mode={mode}
        onModeChange={(m) => onChange(selected, m)}
        onSelect={(option) => onChange(option.id, mode)}
        className="grid grid-cols-2 sm:grid-cols-3 gap-3"
        renderThumb={({ option, mode: m }) => (
          <div className="p-1.5" style={{ background: option.theme[m].surfaceMuted }}>
            <SlidePreview slide={SAMPLE_SLIDES[1]} style={deckStyleFor(option.theme, m)} />
          </div>
        )}
        renderPreview={({ option, mode: m }) => {
          const style = deckStyleFor(option.theme, m);
          return (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {SAMPLE_SLIDES.map((slide, i) => (
                <SlidePreview key={i} slide={slide} style={style} />
              ))}
            </div>
          );
        }}
      />
    </div>
  );
}
