'use client';

import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeft, Download, Loader2, Palette, RefreshCw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ConfirmDialog } from '@/components/DevSessions/ConfirmDialog';
import { decksApi, type DeckWithSlides } from '@/lib/decks/api';
import { DeckThemePicker } from './DeckThemePicker';
import { SlidePreview } from './SlidePreview';

const LAYOUT_LABEL: Record<string, string> = {
  title: 'Title',
  section: 'Section',
  bullets: 'Bullets',
  two_column: 'Two columns',
  stat: 'Numbers',
  quote: 'Quote',
  table: 'Table',
  closing: 'Closing',
};

/** One presentation's slides: ask Sasha to rewrite any of them, delete the ones in the middle, change the theme, save. */
export function DeckEditor({ deckId, sourceId, onBack }: { deckId: string; sourceId: string; onBack: () => void }) {
  const queryClient = useQueryClient();
  const key = ['deck-slides', deckId];
  const { data, error } = useQuery({ queryKey: key, queryFn: () => decksApi.slides(deckId) });
  const [recreating, setRecreating] = useState<number | null>(null);
  const [instruction, setInstruction] = useState('');
  const [deleting, setDeleting] = useState<number | null>(null);
  const [themeOpen, setThemeOpen] = useState(false);

  const applied = (next: DeckWithSlides) => {
    queryClient.setQueryData(key, next);
    queryClient.invalidateQueries({ queryKey: ['decks', sourceId] });
  };
  const failed = (e: unknown) => toast.error(e instanceof Error ? e.message : String(e));

  const recreate = useMutation({
    mutationFn: (index: number) => decksApi.recreateSlide(deckId, index, instruction),
    onSuccess: (next) => {
      applied(next);
      setRecreating(null);
      setInstruction('');
    },
    onError: failed,
  });
  const remove = useMutation({
    mutationFn: (index: number) => decksApi.deleteSlide(deckId, index),
    onSuccess: applied,
    onError: failed,
  });
  const restyle = useMutation({
    mutationFn: ({ themeId, mode }: { themeId: string; mode: 'light' | 'dark' }) => decksApi.setTheme(deckId, themeId, mode),
    onSuccess: applied,
    onError: failed,
  });
  const save = useMutation({
    mutationFn: () => invoke<string>('save_deck_to_downloads', { url: decksApi.fileUrl(deckId), fileName: data!.job.fileName }),
    onSuccess: (path) => toast.success(`Saved to ${path}`),
    onError: failed,
  });

  if (error) return <div className="text-sm text-destructive">{(error as Error).message}</div>;
  if (!data)
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </div>
    );

  const busy = recreate.isPending || remove.isPending || restyle.isPending;
  const { job, slides, style } = data;
  const canDelete = slides.length > 3;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft /> All presentations
        </Button>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setThemeOpen((o) => !o)} disabled={busy}>
            <Palette /> Theme
          </Button>
          <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending || busy}>
            {save.isPending ? <Loader2 className="animate-spin" /> : <Download />}
            Save to Downloads
          </Button>
        </div>
      </div>

      <div>
        <div className="font-medium text-foreground">{job.title}</div>
        <div className="text-xs text-muted-foreground">{slides.length} slides</div>
      </div>

      {themeOpen && (
        <DeckThemePicker
          themeId={job.themeId}
          mode={job.mode}
          disabled={busy}
          onChange={(themeId, mode) => restyle.mutate({ themeId, mode })}
        />
      )}

      <ul className="space-y-3">
        {slides.map((slide, i) => {
          const middle = i > 0 && i < slides.length - 1;
          const working = recreate.isPending && recreate.variables === i;
          return (
            <li key={i} className="flex gap-3 rounded-md border border-border p-2">
              <div className="w-[240px] flex-shrink-0">
                <SlidePreview slide={slide} style={style} />
              </div>
              <div className="min-w-0 flex-1 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground">
                    {i + 1} · {LAYOUT_LABEL[slide.layout] ?? slide.layout}
                  </span>
                  <div className="flex gap-1">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        setRecreating(recreating === i ? null : i);
                        setInstruction('');
                      }}
                    >
                      <RefreshCw /> Recreate
                    </Button>
                    {middle && (
                      <Button
                        variant="outline"
                        size="icon"
                        aria-label={`Delete slide ${i + 1}`}
                        title={canDelete ? 'Delete this slide' : 'A presentation needs at least 3 slides'}
                        disabled={busy || !canDelete}
                        onClick={() => setDeleting(i)}
                      >
                        <Trash2 />
                      </Button>
                    )}
                  </div>
                </div>
                {slide.notes && <p className="line-clamp-2 text-xs text-muted-foreground">{slide.notes}</p>}
                {(recreating === i || working) && (
                  <div className="flex gap-2">
                    <Input
                      value={instruction}
                      onChange={(e) => setInstruction(e.target.value)}
                      placeholder="What should change? (optional)"
                      disabled={working}
                      onKeyDown={(e) => e.key === 'Enter' && !busy && recreate.mutate(i)}
                    />
                    <Button size="sm" disabled={busy} onClick={() => recreate.mutate(i)}>
                      {working ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                      {working ? 'Rewriting…' : 'Rewrite'}
                    </Button>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      <ConfirmDialog
        open={deleting !== null}
        title="Delete this slide?"
        description="It is removed from the presentation. Ask Sasha to recreate other slides if you want a replacement."
        confirmLabel="Delete slide"
        destructive
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting !== null) remove.mutate(deleting);
          setDeleting(null);
        }}
      />
    </div>
  );
}
