'use client';

import { Check } from 'lucide-react';
import type { ThemeMode } from '@/lib/dev-sessions/types';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ModeToggle } from '@/components/DevSessions/themes/ModeToggle';
import { swatches } from '@/components/DevSessions/themes/theme-utils';
import { ThemeFacts } from './ThemeFacts';
import type { ThemeOption, ThemePreviewProps } from './types';

/**
 * The full view of a theme: browse every option on the left, see the chosen
 * one large on the right (what `renderPreview` draws, then its palette and
 * type), and confirm it. Controlled: `previewId` is what's on show, which
 * isn't necessarily the selection until "Use this theme".
 */
export function ThemePreviewDialog({
  open,
  onOpenChange,
  options,
  previewId,
  onPreview,
  selectedId,
  mode,
  onModeChange,
  onSelect,
  renderPreview,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  options: ThemeOption[];
  previewId: string | null;
  onPreview: (id: string) => void;
  selectedId: string | null;
  mode: ThemeMode;
  onModeChange: (mode: ThemeMode) => void;
  onSelect: (option: ThemeOption) => void;
  renderPreview: (props: ThemePreviewProps) => React.ReactNode;
}) {
  const option = options.find((o) => o.id === previewId) ?? options[0];
  if (!option) return null;
  const isSelected = option.id === selectedId;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-6xl w-[96vw] p-0 gap-0 overflow-hidden">
        <DialogHeader className="px-5 pt-5 pb-3 pr-12">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <DialogTitle>{option.theme.name}</DialogTitle>
              <DialogDescription className="mt-1">{option.theme.description}</DialogDescription>
            </div>
            <ModeToggle mode={mode} onChange={onModeChange} />
          </div>
        </DialogHeader>

        <div className="grid grid-cols-1 md:grid-cols-[200px_minmax(0,1fr)] border-t border-border">
          <ul className="flex md:flex-col gap-1 overflow-auto p-2 md:max-h-[68vh] border-b md:border-b-0 md:border-r border-border">
            {options.map((o) => (
              <li key={o.id} className="flex-shrink-0">
                <button
                  type="button"
                  onClick={() => onPreview(o.id)}
                  aria-current={o.id === option.id}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs ${
                    o.id === option.id ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/60'
                  }`}
                >
                  <span className="flex -space-x-1 flex-shrink-0">
                    {swatches(o.theme, mode).slice(0, 3).map((color, i) => (
                      <span key={i} className="h-3 w-3 rounded-full border border-white" style={{ background: color }} />
                    ))}
                  </span>
                  <span className="truncate">{o.theme.name}</span>
                  {o.id === selectedId && <Check className="ml-auto h-3.5 w-3.5 flex-shrink-0 text-primary" />}
                </button>
              </li>
            ))}
          </ul>

          <div className="space-y-4 overflow-y-auto p-4 md:max-h-[68vh] min-w-0">
            {renderPreview({ option, mode })}
            <ThemeFacts theme={option.theme} mode={mode} />
          </div>
        </div>

        <DialogFooter className="px-5 py-3 border-t border-border">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button
            disabled={isSelected}
            onClick={() => {
              onSelect(option);
              onOpenChange(false);
            }}
          >
            {isSelected ? 'In use' : `Use ${option.theme.name}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
