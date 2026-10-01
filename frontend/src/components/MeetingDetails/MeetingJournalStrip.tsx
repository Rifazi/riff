"use client";

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ChevronDown, ChevronUp, HelpCircle, LibraryBig, Loader2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { journalApi, journalKeys, notebookHref, type NotebookEntry } from '@/lib/journal/api';
import { coverColor } from '@/lib/journal/format';
import { ReviewCard } from '@/components/Journal/ReviewCard';

/**
 * Where this meeting went: recording → summary → journals. Shows each journal
 * its parts were filed into, and asks about parts the organizer wasn't sure of.
 */
export function MeetingJournalStrip({ meetingId }: { meetingId: string }) {
  const queryClient = useQueryClient();
  const [showReview, setShowReview] = useState(true);
  const { data: parts = [] } = useQuery({
    queryKey: journalKeys.meeting(meetingId),
    queryFn: () => journalApi.getMeetingEntries(meetingId),
  });
  const { data: statuses = [] } = useQuery({ queryKey: journalKeys.statuses, queryFn: journalApi.getMeetingStatuses });
  const status = statuses.find((s) => s.meeting_id === meetingId);

  const refile = useMutation({
    mutationFn: () => journalApi.organizeMeeting(meetingId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: journalKeys.all }),
    onError: (e) => toast.error(String(e)),
  });

  const filed = parts.filter((p) => p.status === 'filed' && p.notebook_id);
  const review = parts.filter((p) => p.status === 'needs_review');

  // One chip per journal, listing the parts that went there.
  const byJournal = new Map<string, NotebookEntry[]>();
  for (const part of filed) byJournal.set(part.notebook_id!, [...(byJournal.get(part.notebook_id!) ?? []), part]);

  const working = status && ['awaiting_summary', 'pending', 'processing'].includes(status.status);

  return (
    <div className="flex-shrink-0 border-b border-gray-200 bg-stone-50/80 px-4 py-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Link href="/journal" className="flex items-center gap-1.5 text-sm font-semibold text-gray-900 hover:text-indigo-700">
          <LibraryBig className="h-4 w-4" /> Journals
        </Link>

        {working && (
          <span className="flex items-center gap-1.5 text-xs text-gray-600">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {status!.status === 'awaiting_summary'
              ? 'Waiting for the summary, then filing each topic into its journal…'
              : 'Filing each topic into its journal…'}
          </span>
        )}

        {!working && [...byJournal.entries()].map(([journalId, journalParts]) => {
          const color = coverColor(journalParts[0].notebook_color ?? 'indigo');
          return (
            <Link
              key={journalId}
              href={notebookHref(journalId)}
              title={journalParts.map((p) => p.title).join('\n')}
              className={`flex items-center gap-1.5 rounded-full border border-black/5 px-2.5 py-1 text-xs font-medium ${color.cover} ${color.ink} hover:shadow-sm`}
            >
              <span className={`h-2 w-2 rounded-full ${color.dot}`} />
              {journalParts[0].notebook_title}
              {journalParts.length > 1 && <span className="opacity-60">×{journalParts.length}</span>}
            </Link>
          );
        })}

        {!working && review.length > 0 && (
          <button
            type="button"
            onClick={() => setShowReview((v) => !v)}
            className="flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-800 hover:bg-amber-100"
          >
            <HelpCircle className="h-3.5 w-3.5" />
            {review.length} {review.length === 1 ? 'part needs' : 'parts need'} your input
            {showReview ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </button>
        )}

        {!working && status?.status === 'failed' && (
          <span className="flex items-center gap-1.5 text-xs text-amber-800" title={status.error ?? undefined}>
            <AlertTriangle className="h-3.5 w-3.5" /> Couldn’t file this meeting{status.error ? `: ${status.error}` : ''}
          </span>
        )}
        {!working && status?.status === 'skipped' && (
          <span className="text-xs text-gray-500">{status.error ?? 'Nothing to file from this meeting.'}</span>
        )}
        {!working && status?.status === 'unfiled' && (
          <span className="text-xs text-gray-500">Not in your journals yet.</span>
        )}

        {!working && status && (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto h-7 text-xs text-gray-600"
            disabled={refile.isPending}
            onClick={() => refile.mutate()}
            title="Split this meeting into topics again and re-file them"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            {status.status === 'unfiled' || status.status === 'failed' ? 'File now' : 'Re-file'}
          </Button>
        )}
      </div>

      {!working && review.length > 0 && showReview && (
        <div className="mt-2 grid max-h-[40vh] grid-cols-1 gap-2 overflow-y-auto pb-1 custom-scrollbar xl:grid-cols-2">
          {review.map((part) => (
            <ReviewCard key={part.id} entry={part} hideMeeting />
          ))}
        </div>
      )}
    </div>
  );
}
