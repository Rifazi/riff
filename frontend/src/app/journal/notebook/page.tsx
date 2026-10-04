'use client';

import { Suspense, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Combine, MessageCircleQuestion, MoreHorizontal, Pencil, Sparkles, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { BackButton } from '@/components/BackButton';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/DevSessions/ConfirmDialog';
import { RequirementsButton, type RequirementsSource } from '@/components/DevSessions/RequirementsButton';
import { journalApi, journalKeys, type NotebookEntry } from '@/lib/journal/api';
import { coverColor, formatDate, NOTEBOOK_COLORS } from '@/lib/journal/format';
import { JournalShell } from '@/components/Journal/JournalShell';
import { EntryCard } from '@/components/Journal/EntryCard';
import { NotebookSummaryPanel } from '@/components/Journal/NotebookSummaryPanel';
import { AskPanel } from '@/components/Journal/AskPanel';

function NotebookView() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const notebookId = useSearchParams().get('id') ?? '';

  const { data, isLoading, error } = useQuery({
    queryKey: journalKeys.notebook(notebookId),
    queryFn: () => journalApi.getNotebook(notebookId),
    enabled: !!notebookId,
  });
  const { data: allNotebooks = [] } = useQuery({
    queryKey: journalKeys.notebooks,
    queryFn: journalApi.listNotebooks,
  });
  const otherNotebooks = allNotebooks.filter((n) => n.id !== notebookId);
  const overview = allNotebooks.find((n) => n.id === notebookId);

  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ title: '', description: '', color: '' });
  const [merging, setMerging] = useState(false);
  const [mergeTarget, setMergeTarget] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [movingEntry, setMovingEntry] = useState<NotebookEntry | null>(null);
  const [moveTarget, setMoveTarget] = useState('');
  const [removingEntry, setRemovingEntry] = useState<NotebookEntry | null>(null);
  const journalTitle = data?.notebook.title ?? '';
  const journalOverview = data?.notebook.summary_markdown ?? null;
  const requirementsSource = useMemo<RequirementsSource>(
    () => ({
      kind: 'journal',
      id: notebookId,
      title: journalTitle,
      getSummaryMarkdown: async () => journalOverview,
    }),
    [notebookId, journalTitle, journalOverview],
  );

  const invalidate = () => queryClient.invalidateQueries({ queryKey: journalKeys.all });
  const onError = (e: unknown) => toast.error(String(e));

  const updateMutation = useMutation({
    mutationFn: () => journalApi.updateNotebook(notebookId, form),
    onSuccess: () => {
      invalidate();
      setEditing(false);
    },
    onError,
  });
  const mergeMutation = useMutation({
    mutationFn: () => journalApi.mergeNotebooks(notebookId, mergeTarget),
    onSuccess: () => {
      invalidate();
      router.replace(`/journal/notebook?id=${encodeURIComponent(mergeTarget)}`);
      setMerging(false);
    },
    onError,
  });
  const deleteMutation = useMutation({
    mutationFn: () => journalApi.deleteNotebook(notebookId),
    onSuccess: () => {
      invalidate();
      router.push('/journal');
    },
    onError,
  });
  const moveMutation = useMutation({
    mutationFn: () => journalApi.fileEntry(movingEntry!.id, { notebookId: moveTarget }),
    onSuccess: () => {
      invalidate();
      setMovingEntry(null);
      toast.success('Note moved');
    },
    onError,
  });
  const removeMutation = useMutation({
    mutationFn: (entryId: string) => journalApi.deleteEntry(entryId),
    onSuccess: () => {
      invalidate();
      setRemovingEntry(null);
    },
    onError,
  });
  const refileMutation = useMutation({
    mutationFn: (meetingId: string) => journalApi.organizeMeeting(meetingId),
    onError,
  });

  // Entries arrive newest meeting first; group them under one heading per meeting day.
  const groups = useMemo(() => {
    const byDay = new Map<string, NotebookEntry[]>();
    for (const entry of data?.entries ?? []) {
      const day = formatDate(entry.meeting_started_at);
      byDay.set(day, [...(byDay.get(day) ?? []), entry]);
    }
    return [...byDay.entries()];
  }, [data?.entries]);

  if (!notebookId) return <div className="p-8 text-sm text-muted-foreground">No notebook selected.</div>;
  if (isLoading) return <div className="p-8 text-sm text-muted-foreground">Loading…</div>;
  if (error || !data) {
    return (
      <div className="p-8 text-sm text-destructive">
        {String(error ?? 'Journal not found')}{' '}
        <Link href="/journal" className="underline">
          Back to journals
        </Link>
      </div>
    );
  }

  const { notebook, entries } = data;
  const color = coverColor(notebook.color);
  const meetingCount = new Set(entries.map((e) => e.meeting_id)).size;

  return (
    <JournalShell
      back={<BackButton fallbackHref="/journal" />}
      title={
        <span className="flex items-center gap-3">
          <span className={`inline-block h-7 w-2 rounded-sm ${color.spine}`} />
          <span className="font-serif">{notebook.title}</span>
        </span>
      }
      subtitle={
        <>
          {notebook.description && <span>{notebook.description} · </span>}
          {entries.length} {entries.length === 1 ? 'note' : 'notes'} from {meetingCount}{' '}
          {meetingCount === 1 ? 'meeting' : 'meetings'}
        </>
      }
      actions={
        <>
          <RequirementsButton source={requirementsSource} disabled={entries.length === 0} />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon" aria-label="Journal actions">
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={() => {
                  setForm({
                    title: notebook.title,
                    description: notebook.description ?? '',
                    color: notebook.color,
                  });
                  setEditing(true);
                }}
              >
                <Pencil className="mr-2 h-4 w-4" /> Edit journal
              </DropdownMenuItem>
              <DropdownMenuItem disabled={otherNotebooks.length === 0} onClick={() => setMerging(true)}>
                <Combine className="mr-2 h-4 w-4" /> Merge into another journal
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => setConfirmDelete(true)}
                className="text-destructive focus:text-destructive"
              >
                <Trash2 className="mr-2 h-4 w-4" /> Delete journal
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_420px]">
        {/* Notes timeline */}
        <div className="min-w-0 space-y-8">
          {entries.length === 0 && (
            <Card className="border-dashed py-12 text-center text-sm text-muted-foreground shadow-none">
              No notes yet. Parts of meetings that discuss this topic will be filed here.
            </Card>
          )}
          {groups.map(([day, dayEntries]) => (
            <section key={day}>
              <h2 className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <span className={`h-2 w-2 rounded-full ${color.dot}`} />
                {day}
              </h2>
              <div className="space-y-3 border-l border-border pl-4">
                {dayEntries.map((entry) => (
                  <EntryCard
                    key={entry.id}
                    entry={entry}
                    onMove={() => {
                      setMoveTarget('');
                      setMovingEntry(entry);
                    }}
                    onRefile={() => {
                      refileMutation.mutate(entry.meeting_id);
                      toast.message(`Re-filing “${entry.meeting_title}”…`);
                    }}
                    onDelete={() => setRemovingEntry(entry)}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>

        {/* Summary + Ask */}
        <aside className="lg:sticky lg:top-0 lg:self-start">
          <Card className="flex h-[calc(100vh-11rem)] min-h-[28rem] flex-col p-4">
            <Tabs defaultValue="summary" className="flex min-h-0 flex-1 flex-col">
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="summary">
                  <Sparkles className="mr-1.5 h-3.5 w-3.5" /> Overview
                </TabsTrigger>
                <TabsTrigger value="ask">
                  <MessageCircleQuestion className="mr-1.5 h-3.5 w-3.5" /> Ask
                </TabsTrigger>
              </TabsList>
              <TabsContent
                value="summary"
                className="mt-4 min-h-0 flex-1 overflow-y-auto custom-scrollbar data-[state=inactive]:hidden"
              >
                <NotebookSummaryPanel
                  notebook={notebook}
                  hasEntries={entries.length > 0}
                  stale={!!overview?.summary_stale}
                />
              </TabsContent>
              <TabsContent value="ask" forceMount className="mt-4 min-h-0 flex-1 data-[state=inactive]:hidden">
                <AskPanel notebookId={notebook.id} placeholder={`Ask about ${notebook.title}…`} />
              </TabsContent>
            </Tabs>
          </Card>
        </aside>
      </div>

      {/* Edit journal */}
      <Dialog open={editing} onOpenChange={setEditing}>
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle>Edit journal</DialogTitle>
            <DialogDescription>The description tells Riff which future discussions belong here.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              placeholder="Title"
            />
            <Textarea
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              placeholder="What belongs in this journal?"
              rows={3}
            />
            <div className="flex flex-wrap gap-2">
              {Object.entries(NOTEBOOK_COLORS).map(([name, swatch]) => (
                <button
                  key={name}
                  type="button"
                  aria-label={name}
                  onClick={() => setForm({ ...form, color: name })}
                  className={`h-7 w-7 rounded-full ${swatch.spine} ${form.color === name ? 'ring-2 ring-offset-2 ring-foreground' : ''}`}
                />
              ))}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button
              variant="default"
              disabled={!form.title.trim() || updateMutation.isPending}
              onClick={() => updateMutation.mutate()}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Merge notebook */}
      <Dialog open={merging} onOpenChange={setMerging}>
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle>Merge “{notebook.title}”</DialogTitle>
            <DialogDescription>
              Its notes move into the journal you pick, and this journal is removed.
            </DialogDescription>
          </DialogHeader>
          <NotebookSelect value={mergeTarget} onChange={setMergeTarget} notebooks={otherNotebooks} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setMerging(false)}>
              Cancel
            </Button>
            <Button
              variant="default"
              disabled={!mergeTarget || mergeMutation.isPending}
              onClick={() => mergeMutation.mutate()}
            >
              Merge
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Move note */}
      <Dialog open={!!movingEntry} onOpenChange={(open) => !open && setMovingEntry(null)}>
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle>Move “{movingEntry?.title}”</DialogTitle>
            <DialogDescription>Pick the journal this note belongs in.</DialogDescription>
          </DialogHeader>
          <NotebookSelect value={moveTarget} onChange={setMoveTarget} notebooks={otherNotebooks} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setMovingEntry(null)}>
              Cancel
            </Button>
            <Button
              variant="default"
              disabled={!moveTarget || moveMutation.isPending}
              onClick={() => moveMutation.mutate()}
            >
              Move
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmDelete}
        title={`Delete “${notebook.title}”?`}
        description="Its notes are removed. The meetings, summaries, transcripts and recordings are kept."
        confirmLabel="Delete journal"
        destructive
        onConfirm={() => deleteMutation.mutate()}
        onCancel={() => setConfirmDelete(false)}
      />
      <ConfirmDialog
        open={!!removingEntry}
        title="Remove this note?"
        description="The meeting itself is kept. Re-filing the meeting can bring the note back."
        confirmLabel="Remove note"
        destructive
        onConfirm={() => removingEntry && removeMutation.mutate(removingEntry.id)}
        onCancel={() => setRemovingEntry(null)}
      />
    </JournalShell>
  );
}

function NotebookSelect({
  value,
  onChange,
  notebooks,
}: {
  value: string;
  onChange: (id: string) => void;
  notebooks: { id: string; title: string }[];
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger>
        <SelectValue placeholder="Choose a journal" />
      </SelectTrigger>
      <SelectContent>
        {notebooks.map((n) => (
          <SelectItem key={n.id} value={n.id}>
            {n.title}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export default function NotebookPage() {
  return (
    <Suspense fallback={<div className="p-8 text-sm text-muted-foreground">Loading…</div>}>
      <NotebookView />
    </Suspense>
  );
}
