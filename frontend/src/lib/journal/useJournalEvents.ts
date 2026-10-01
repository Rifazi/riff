'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { listen } from '@tauri-apps/api/event';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { JOURNAL_UPDATED_EVENT, journalKeys, type JournalUpdatedPayload } from './api';

/**
 * Keeps Journal queries fresh as the Rust organizer files meetings, and lets
 * the user know when a new meeting landed in their journals. Mounted once in
 * the root layout so recordings stopped from anywhere are announced.
 */
export function useJournalEvents() {
  const queryClient = useQueryClient();
  const router = useRouter();

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    listen<JournalUpdatedPayload>(JOURNAL_UPDATED_EVENT, ({ payload }) => {
      queryClient.invalidateQueries({ queryKey: journalKeys.all });
      // One toast id, so filing a backlog updates a single toast instead of stacking them.
      if (payload.status === 'processing') {
        toast.loading('Filing meeting topics into your journals…', { id: 'journal-filing' });
      } else if (payload.status === 'completed') {
        toast.success('Meeting filed into your journals', {
          id: 'journal-filing',
          action: { label: 'Open journals', onClick: () => router.push('/journal') },
        });
      } else if (payload.status === 'needs_review' && payload.meeting_id) {
        const meetingId = payload.meeting_id;
        toast.warning('Riff needs your input on where some topics belong', {
          id: 'journal-filing',
          duration: 10_000,
          action: { label: 'Review', onClick: () => router.push(`/meeting-details?id=${encodeURIComponent(meetingId)}`) },
        });
      } else if (payload.status === 'failed') {
        toast.error('Could not file meeting into your journals', {
          id: 'journal-filing',
          description: payload.error ?? undefined,
        });
      } else if (payload.status === 'skipped') {
        toast.dismiss('journal-filing');
      }
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {
        // Not running inside Tauri (e.g. plain `next dev`): nothing to listen to.
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [queryClient, router]);
}

export function JournalEventsBridge() {
  useJournalEvents();
  return null;
}
