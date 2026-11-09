'use client';

import { useState } from 'react';
import type { ThemeMode } from '@/lib/dev-sessions/types';
import { ThemeChip } from './ThemeChip';
import { ThemePreviewDialog } from './ThemePreviewDialog';
import type { ThemeOption, ThemePreviewProps } from './types';

/**
 * A compact grid of themes; clicking one opens a full preview to look it over
 * and confirm. Knows nothing about apps or decks: callers pass the options,
 * the selection and what a preview draws (`renderPreview`), so the same
 * picker serves the UI theme and presentations.
 */
export function ThemePicker({
  options,
  selectedId,
  onSelect,
  mode,
  onModeChange,
  renderPreview,
  renderThumb,
  leading,
  className = 'grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3',
}: {
  options: ThemeOption[];
  selectedId: string | null;
  onSelect: (option: ThemeOption) => void;
  mode: ThemeMode;
  onModeChange: (mode: ThemeMode) => void;
  renderPreview: (props: ThemePreviewProps) => React.ReactNode;
  // A small applied-theme miniature shown on each chip.
  renderThumb?: (props: ThemePreviewProps) => React.ReactNode;
  // Extra grid cells before the themes (e.g. a "No theme" choice).
  leading?: React.ReactNode;
  className?: string;
}) {
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  return (
    <>
      <div className={className}>
        {leading}
        {options.map((option) => (
          <ThemeChip
            key={option.id}
            option={option}
            mode={mode}
            selected={option.id === selectedId}
            thumb={renderThumb?.({ option, mode })}
            onOpen={() => {
              setPreviewId(option.id);
              setOpen(true);
            }}
          />
        ))}
      </div>
      <ThemePreviewDialog
        open={open}
        onOpenChange={setOpen}
        options={options}
        previewId={previewId}
        onPreview={setPreviewId}
        selectedId={selectedId}
        mode={mode}
        onModeChange={onModeChange}
        onSelect={onSelect}
        renderPreview={renderPreview}
      />
    </>
  );
}
