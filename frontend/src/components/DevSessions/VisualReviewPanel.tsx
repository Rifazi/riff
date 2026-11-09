'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Eye, Loader2, Undo2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { api } from '@/lib/dev-sessions/api';
import { UIUX_PERSONA } from '@/lib/dev-sessions/agents';
import type { SessionRecord } from '@/lib/dev-sessions/types';
import { CollapsibleSection } from './CollapsibleSection';
import { ErrorText } from './PageShell';

/**
 * The screens a branch changes, as the UI/UX agent saw them, and its verdict.
 * While the agent is satisfied (or out of rounds) the human approves the
 * screenshots here, or asks the coding lead for changes. Starting QA is the
 * Coding tab's diff approval, not this panel's.
 */
export function VisualReviewPanel({
  session,
  onSendToCoder,
  onRetry,
  retrying = false,
}: {
  session: SessionRecord;
  onSendToCoder: (message: string) => void;
  /** Runs the review again (the Coding tab's diff approval). */
  onRetry?: () => void;
  retrying?: boolean;
}) {
  const review = session.visualReview;
  const queryClient = useQueryClient();
  const [zoomed, setZoomed] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState('');

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['session', session.id] });

  const approve = useMutation({
    mutationFn: () => api.approveVisualReview(session.id),
    onSuccess: async () => {
      await refresh();
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
    },
  });
  const requestChanges = useMutation({
    mutationFn: (text: string) => api.requestVisualChanges(session.id, text),
    onSuccess: async ({ fixMessage }) => {
      await refresh();
      setAsking(false);
      setNote('');
      onSendToCoder(fixMessage);
    },
  });

  if (!review || review.status === 'approved' || review.status === 'skipped') {
    // Settled: one line, so the human can still see why nothing was asked of them.
    if (!review) return null;
    return (
      <div className="text-xs text-muted-foreground">
        {review.status === 'approved'
          ? 'Screenshots approved.'
          : `Visual review skipped: ${review.reason ?? review.summary}`}
      </div>
    );
  }

  if (review.status === 'needs-address') {
    return <AppAddressForm session={session} reason={review.reason ?? review.summary} onRetry={onRetry} retrying={retrying} />;
  }

  const waiting = review.status === 'awaiting-human';
  return (
    <section className="space-y-2" aria-label="Visual review">
      <CollapsibleSection
        icon={Eye}
        title="Visual review"
        aside={`by ${UIUX_PERSONA.name}`}
        actions={
          waiting ? (
            review.verdict === 'needs-changes' ? (
              <Badge variant="warning">Concerns remain</Badge>
            ) : (
              <Badge variant="success">Looks good</Badge>
            )
          ) : (
            <Badge variant="secondary">Sent back to coding</Badge>
          )
        }
        defaultOpen
        bodyClassName="max-h-[40vh] overflow-y-auto custom-scrollbar space-y-3"
      >
        <p className="text-sm text-foreground">{review.summary}</p>

        {review.findings.length > 0 && (
          <ul className="space-y-1 text-sm">
            {review.findings.map((f, i) => (
              <li key={i} className="flex items-start gap-2">
                <Badge variant={f.severity === 'blocker' ? 'destructive' : 'outline'} className="mt-0.5 shrink-0">
                  {f.severity}
                </Badge>
                <span className="text-foreground">{f.text}</span>
              </li>
            ))}
          </ul>
        )}

        {review.shots.length > 0 && (
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {review.shots.map((s) => (
              <li key={s.file}>
                <button
                  type="button"
                  onClick={() => setZoomed(s.file)}
                  className="block w-full overflow-hidden rounded-md border border-border text-left hover:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element -- a local screenshot served by the agent server */}
                  <img
                    src={api.visualShotUrl(session.id, s.file)}
                    alt={s.label}
                    loading="lazy"
                    className="aspect-[4/3] w-full object-cover object-top"
                  />
                  <span className="block truncate px-2 py-1 text-xs text-muted-foreground">{s.label}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </CollapsibleSection>

      {waiting && (
        <>
          <ErrorText>{approve.error ? (approve.error as Error).message : null}</ErrorText>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="success" onClick={() => approve.mutate()} disabled={approve.isPending}>
              {approve.isPending ? <Loader2 className="animate-spin" /> : <CheckCircle2 />}
              {approve.isPending ? 'Approving…' : 'Approve screenshots'}
            </Button>
            <Button variant="outline" onClick={() => setAsking(true)} disabled={approve.isPending}>
              <Undo2 />
              Request changes
            </Button>
          </div>
        </>
      )}

      <Dialog open={zoomed !== null} onOpenChange={(open) => !open && setZoomed(null)}>
        <DialogContent className="sm:max-w-[min(1100px,92vw)] max-h-[92vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{review.shots.find((s) => s.file === zoomed)?.label ?? 'Screenshot'}</DialogTitle>
            <DialogDescription className="sr-only">Full-size screenshot</DialogDescription>
          </DialogHeader>
          {zoomed && (
            // eslint-disable-next-line @next/next/no-img-element -- a local screenshot served by the agent server
            <img
              src={api.visualShotUrl(session.id, zoomed)}
              alt={review.shots.find((s) => s.file === zoomed)?.label ?? 'Screenshot'}
              className="w-full rounded-md border border-border"
            />
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={asking} onOpenChange={(open) => !open && !requestChanges.isPending && setAsking(false)}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>Request changes</DialogTitle>
            <DialogDescription>
              The coding lead gets your note with the UI/UX agent&apos;s findings and fixes it before QA starts.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={4}
            placeholder="What should look different?"
            autoFocus
          />
          <ErrorText>{requestChanges.error ? (requestChanges.error as Error).message : null}</ErrorText>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAsking(false)} disabled={requestChanges.isPending}>
              Cancel
            </Button>
            <Button onClick={() => requestChanges.mutate(note)} disabled={!note.trim() || requestChanges.isPending}>
              {requestChanges.isPending && <Loader2 className="animate-spin" />}
              {requestChanges.isPending ? 'Sending…' : 'Send to coding'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

/** The app wasn't running and Riff couldn't start it: ask where it lives, or how to start it, then run the review again. */
function AppAddressForm({
  session,
  reason,
  onRetry,
  retrying,
}: {
  session: SessionRecord;
  reason: string;
  onRetry?: () => void;
  retrying: boolean;
}) {
  const queryClient = useQueryClient();
  const app = useQuery({ queryKey: ['apps'], queryFn: () => api.listApps() });
  const current = app.data?.find((a) => a.id === session.appId);
  const [url, setUrl] = useState('');
  const [command, setCommand] = useState('');
  const [seeded, setSeeded] = useState(false);
  if (current && !seeded) {
    setSeeded(true);
    setUrl(current.devUrl ?? '');
    setCommand(current.devCommand ?? '');
  }

  const save = useMutation({
    mutationFn: () => api.updateApp(session.appId, { devUrl: url.trim() || null, devCommand: command.trim() || null }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['apps'] });
      onRetry?.();
    },
  });

  return (
    <section className="space-y-3 rounded-md border border-warning/40 p-3" aria-label="Visual review needs the app's address">
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        <Eye className="h-4 w-4" />
        Visual review can&apos;t find the app
      </div>
      <p className="text-sm text-muted-foreground whitespace-pre-wrap">{reason}</p>
      <div className="space-y-1">
        <label className="text-xs font-medium text-foreground" htmlFor="app-dev-url">
          Address of the running app
        </label>
        <Input id="app-dev-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://localhost:5173" />
      </div>
      <div className="space-y-1">
        <label className="text-xs font-medium text-foreground" htmlFor="app-dev-command">
          Command that starts the whole stack (optional)
        </label>
        <Input
          id="app-dev-command"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          placeholder="docker compose up, or npm run dev:all"
        />
        <p className="text-xs text-muted-foreground">
          Run in the app&apos;s repo when nothing answers at the address. Riff waits for the address to come up, then stops it after the review.
        </p>
      </div>
      <ErrorText>{save.error ? (save.error as Error).message : null}</ErrorText>
      <Button onClick={() => save.mutate()} disabled={(!url.trim() && !command.trim()) || save.isPending || retrying}>
        {(save.isPending || retrying) && <Loader2 className="animate-spin" />}
        {save.isPending || retrying ? 'Reviewing…' : 'Save and retry review'}
      </Button>
    </section>
  );
}
