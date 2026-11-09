'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { invoke } from '@tauri-apps/api/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertCircle, Download, Loader2, Pencil, Presentation, Sparkles, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ConfirmDialog } from '@/components/DevSessions/ConfirmDialog';
import { useAgentServerHealth } from '@/components/DevSessions/AgentServerBanner';
import type { ThemeMode } from '@/lib/dev-sessions/types';
import { journalApi } from '@/lib/journal/api';
import { decksApi, type DeckJob, type DeckLength } from '@/lib/decks/api';
import Analytics from '@/lib/analytics';
import { DeckEditor } from './DeckEditor';
import { DeckThemePicker } from './DeckThemePicker';

export type PresentationSource = {
  /** Journal id. */
  id: string;
  title: string;
  /** The journal's overview, sent along as extra context. */
  overview: string | null;
};

const LENGTHS: { value: DeckLength; label: string }[] = [
  { value: 'short', label: 'Short (up to 7 slides)' },
  { value: 'standard', label: 'Standard (8 to 12 slides)' },
  { value: 'detailed', label: 'Detailed (13 to 20 slides)' },
];

type View = { kind: 'home' } | { kind: 'edit'; id: string };

/** Turns a journal into a PowerPoint deck, written by the slides agent (Sasha), and keeps the decks made before. */
export function PresentationButton({ source, disabled }: { source: PresentationSource; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        disabled={disabled}
        onClick={() => setOpen(true)}
        title={disabled ? 'This journal has nothing to present yet' : 'Turn this journal into a PowerPoint presentation'}
      >
        <Presentation />
        Create presentation
      </Button>
      <PresentationDialog open={open} onOpenChange={setOpen} source={source} />
    </>
  );
}

function PresentationDialog({
  open,
  onOpenChange,
  source,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  source: PresentationSource;
}) {
  const queryClient = useQueryClient();
  const { data: healthy } = useAgentServerHealth();
  const [view, setView] = useState<View>({ kind: 'home' });
  const [audience, setAudience] = useState('');
  const [length, setLength] = useState<DeckLength>('standard');
  const [focus, setFocus] = useState('');
  const [speakerNotes, setSpeakerNotes] = useState(true);
  const [themeId, setThemeId] = useState('');
  const [mode, setMode] = useState<ThemeMode>('light');
  const [jobId, setJobId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<DeckJob | null>(null);

  const listKey = ['decks', source.id];
  const { data: decks } = useQuery({
    queryKey: listKey,
    queryFn: () => decksApi.list(source.id),
    enabled: open && healthy === true,
  });

  const start = useMutation({
    mutationFn: async () => {
      const brief = await journalApi.requirementsBrief(source.id);
      if (!brief.notes_markdown.trim()) throw new Error('This journal has nothing to present yet.');
      return decksApi.create({
        title: source.title,
        sourceId: source.id,
        notes: brief.notes_markdown,
        overview: source.overview,
        covers: brief.covers,
        audience,
        length,
        speakerNotes,
        focus: focus || undefined,
        themeId,
        mode,
      });
    },
    onSuccess: (job) => {
      Analytics.trackButtonClick('create_presentation_from_journal', 'journal');
      setJobId(job.id);
    },
  });

  // Follows the new deck until it is built, then opens it for editing.
  const { data: job } = useQuery({
    queryKey: ['deck', jobId],
    queryFn: () => decksApi.get(jobId!),
    enabled: jobId !== null,
    refetchInterval: (query) => (query.state.data?.status === 'working' ? 1500 : false),
  });

  useEffect(() => {
    if (job?.status !== 'done') return;
    queryClient.invalidateQueries({ queryKey: listKey });
    setView({ kind: 'edit', id: job.id });
    setJobId(null);
    // listKey is derived from source.id
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.status, job?.id]);

  const remove = useMutation({
    mutationFn: (id: string) => decksApi.remove(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: listKey }),
    onError: (e) => toast.error(String(e)),
  });
  const save = useMutation({
    mutationFn: (d: DeckJob) => invoke<string>('save_deck_to_downloads', { url: decksApi.fileUrl(d.id), fileName: d.fileName }),
    onSuccess: (path) => toast.success(`Saved to ${path}`),
    onError: (e) => toast.error(String(e)),
  });

  const working = start.isPending || (jobId !== null && job?.status !== 'failed');
  const failure = job?.status === 'failed' ? job.error : start.isError ? (start.error as Error).message : null;
  const retry = () => {
    setJobId(null);
    start.mutate();
  };
  const close = (next: boolean) => {
    onOpenChange(next);
    if (!next) setView({ kind: 'home' });
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-[780px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-primary" />
            {view.kind === 'edit' ? 'Edit presentation' : 'Presentations from this journal'}
          </DialogTitle>
          <DialogDescription>
            Sasha, the presentation designer, reads every note in the journal, finds the story and builds a PowerPoint
            deck in the theme you pick. You can ask her to rewrite any slide afterwards.
          </DialogDescription>
        </DialogHeader>

        {healthy === false ? (
          <div className="rounded-md border border-warning/50 bg-warning/10 px-3 py-2 text-sm text-foreground">
            The agent server isn't running yet.{' '}
            <Link href="/dev-sessions" className="font-medium underline" onClick={() => close(false)}>
              Open Dev Sessions
            </Link>{' '}
            to see its status.
          </div>
        ) : view.kind === 'edit' ? (
          <DeckEditor deckId={view.id} sourceId={source.id} onBack={() => setView({ kind: 'home' })} />
        ) : (
          <div className="space-y-5 py-1">
            {decks && decks.length > 0 && (
              <section className="space-y-2">
                <Label>Earlier presentations</Label>
                <ul className="divide-y divide-border rounded-md border border-border">
                  {decks.map((d) => (
                    <li key={d.id} className="flex items-center justify-between gap-3 px-3 py-2">
                      <div className="min-w-0 text-sm">
                        <div className="truncate font-medium text-foreground">{d.title}</div>
                        <div className="text-xs text-muted-foreground">
                          {new Date(d.createdAt).toLocaleString()}
                          {d.status === 'done' && ` · ${d.slideCount} slides`}
                          {d.status === 'working' && ' · still being written'}
                          {d.status === 'failed' && ' · failed'}
                        </div>
                      </div>
                      <div className="flex flex-shrink-0 gap-1">
                        {d.status === 'done' && (
                          <>
                            <Button variant="outline" size="sm" onClick={() => setView({ kind: 'edit', id: d.id })}>
                              <Pencil /> Edit
                            </Button>
                            <Button
                              variant="outline"
                              size="icon"
                              aria-label="Save to Downloads"
                              title="Save to Downloads"
                              disabled={save.isPending}
                              onClick={() => save.mutate(d)}
                            >
                              <Download />
                            </Button>
                          </>
                        )}
                        <Button
                          variant="outline"
                          size="icon"
                          aria-label="Delete presentation"
                          title="Delete this presentation"
                          disabled={d.status === 'working'}
                          onClick={() => setDeleting(d)}
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {working ? (
              <div className="flex items-center gap-3 rounded-md border border-border bg-muted px-3 py-3 text-sm">
                <Loader2 className="w-5 h-5 animate-spin text-primary" />
                <span>{job?.progress ?? 'Starting…'}</span>
              </div>
            ) : (
              <section className="space-y-4">
                <Label className="text-sm">New presentation</Label>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label>
                      Audience <span className="text-muted-foreground font-normal">(optional)</span>
                    </Label>
                    <Input
                      value={audience}
                      onChange={(e) => setAudience(e.target.value)}
                      placeholder="e.g. leadership team, new hires"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Length</Label>
                    <Select value={length} onValueChange={(v) => setLength(v as DeckLength)}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {LENGTHS.map((l) => (
                          <SelectItem key={l.value} value={l.value}>
                            {l.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label>
                    Focus <span className="text-muted-foreground font-normal">(optional)</span>
                  </Label>
                  <Textarea
                    value={focus}
                    onChange={(e) => setFocus(e.target.value)}
                    placeholder="What to emphasise or leave out"
                    rows={2}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Theme</Label>
                  <DeckThemePicker
                    themeId={themeId}
                    mode={mode}
                    onChange={(id, m) => {
                      setThemeId(id);
                      setMode(m);
                    }}
                  />
                </div>
                <label className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 cursor-pointer">
                  <span className="text-sm">
                    <span className="font-medium text-foreground">Speaker notes</span>
                    <span className="block text-xs text-muted-foreground">What to say on each slide, with sources.</span>
                  </span>
                  <Switch checked={speakerNotes} onCheckedChange={setSpeakerNotes} />
                </label>
                {failure && (
                  <div className="flex items-start gap-2 text-sm text-destructive">
                    <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                    {failure}
                  </div>
                )}
                <div className="flex justify-end">
                  <Button onClick={job?.status === 'failed' ? retry : () => start.mutate()} disabled={healthy !== true}>
                    <Presentation />
                    {job?.status === 'failed' ? 'Try again' : 'Create presentation'}
                  </Button>
                </div>
              </section>
            )}
          </div>
        )}
      </DialogContent>

      <ConfirmDialog
        open={deleting !== null}
        title="Delete this presentation?"
        description={`"${deleting?.title ?? ''}" and its saved slides are removed. Copies you already saved to Downloads are not touched.`}
        confirmLabel="Delete presentation"
        destructive
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) remove.mutate(deleting.id);
          setDeleting(null);
        }}
      />
    </Dialog>
  );
}
