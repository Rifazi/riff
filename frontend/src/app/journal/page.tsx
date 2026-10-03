'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LibraryBig, Mic, MessageCircleQuestion, Plus, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { journalApi, journalKeys, notebookHref, type NotebookOverview } from '@/lib/journal/api';
import { JOURNAL_KINDS, useSearch, type SearchHit } from '@/lib/search/api';
import { SearchHitLines } from '@/components/Search/SearchHitText';
import { JournalShell } from '@/components/Journal/JournalShell';
import { NotebookCover } from '@/components/Journal/NotebookCover';
import { FilingStatus } from '@/components/Journal/FilingStatus';
import { AskPanel } from '@/components/Journal/AskPanel';
import { ReviewInbox } from '@/components/Journal/ReviewCard';

export default function JournalPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data: notebooks = [], isLoading, error } = useQuery({
    queryKey: journalKeys.notebooks,
    queryFn: journalApi.listNotebooks,
  });

  const [query, setQuery] = useState('');
  const [askOpen, setAskOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newDescription, setNewDescription] = useState('');

  const createMutation = useMutation({
    mutationFn: () => journalApi.createNotebook(newTitle, newDescription || undefined),
    onSuccess: (notebook) => {
      queryClient.invalidateQueries({ queryKey: journalKeys.all });
      setCreating(false);
      setNewTitle('');
      setNewDescription('');
      router.push(notebookHref(notebook.id));
    },
  });

  // Journals and their notes, best match first.
  const { hits, isSearching } = useSearch(query, JOURNAL_KINDS);
  const visible = useMemo((): { notebook: NotebookOverview; hit?: SearchHit }[] => {
    if (!query.trim()) return notebooks.map((notebook) => ({ notebook }));
    const byId = new Map(notebooks.map((n) => [n.id, n]));
    return hits.flatMap((hit) => {
      const notebook = byId.get(hit.group);
      return notebook ? [{ notebook, hit }] : [];
    });
  }, [notebooks, query, hits]);

  const totalNotes = notebooks.reduce((sum, n) => sum + n.entry_count, 0);

  return (
    <JournalShell
      title="Journals"
      subtitle={
        notebooks.length > 0
          ? `${notebooks.length} ${notebooks.length === 1 ? 'journal' : 'journals'} · ${totalNotes} notes compiled from your meeting summaries`
          : 'Every meeting is summarized and each topic is filed into its journal'
      }
      actions={
        <>
          <Button variant="outline" onClick={() => setCreating(true)}>
            <Plus /> New journal
          </Button>
          <Button variant="blue" onClick={() => setAskOpen(true)} disabled={notebooks.length === 0}>
            <MessageCircleQuestion /> Ask your journals
          </Button>
        </>
      }
    >
      <FilingStatus />
      <ReviewInbox />

      {notebooks.length > 0 && (
        <div className="relative mb-6 max-w-md">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search journals and notes…"
            className="bg-white pl-9"
          />
        </div>
      )}

      {isLoading && <div className="py-10 text-center text-sm text-gray-500">Loading…</div>}
      {error && <div className="text-sm text-red-600">{String(error)}</div>}

      {!isLoading && notebooks.length === 0 && (
        <div className="rounded-xl border border-dashed border-stone-300 bg-white py-16 text-center">
          <LibraryBig className="mx-auto h-10 w-10 text-stone-300" />
          <h2 className="mt-3 font-semibold text-gray-900">No journals yet</h2>
          <p className="mx-auto mt-1 max-w-sm text-sm text-gray-500">
            Record a meeting and Riff summarizes it, splits it into topics and files each one into its journal. Each
            journal grows with every meeting that touches its topic, and Riff asks you when it isn’t sure.
          </p>
          <Button className="mt-5" variant="blue" onClick={() => router.push('/')}>
            <Mic /> Start recording
          </Button>
        </div>
      )}

      {visible.length > 0 && (
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {visible.map(({ notebook, hit }) => (
            <div key={notebook.id}>
              <NotebookCover notebook={notebook} />
              {hit && <SearchHitLines hit={hit} />}
            </div>
          ))}
        </div>
      )}
      {notebooks.length > 0 && visible.length === 0 && !isSearching && (
        <div className="py-10 text-center text-sm text-gray-500">No journals match “{query}”.</div>
      )}

      <Sheet open={askOpen} onOpenChange={setAskOpen}>
        <SheetContent className="flex w-full flex-col sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>Ask your journals</SheetTitle>
            <SheetDescription>Answers draw on every journal, with the meetings and moments they came from.</SheetDescription>
          </SheetHeader>
          <div className="mt-4 min-h-0 flex-1">
            <AskPanel placeholder="e.g. What did we decide about pricing?" />
          </div>
        </SheetContent>
      </Sheet>

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle>New journal</DialogTitle>
            <DialogDescription>
              Riff files parts of future meetings into it when they discuss this topic. The description helps it decide.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="Topic, e.g. Q4 Budget" autoFocus />
            <Textarea
              value={newDescription}
              onChange={(e) => setNewDescription(e.target.value)}
              placeholder="What belongs in this journal?"
              rows={3}
            />
            {createMutation.error && <p className="text-sm text-red-600">{String(createMutation.error)}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button variant="blue" disabled={!newTitle.trim() || createMutation.isPending} onClick={() => createMutation.mutate()}>
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </JournalShell>
  );
}
