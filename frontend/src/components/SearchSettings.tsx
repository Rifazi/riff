'use client';

import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Loader2, RefreshCw, Sparkles, Trash2, Download } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { searchApi, useSearchStatus } from '@/lib/search/api';

const mb = (bytes: number) => `${Math.round(bytes / 1_000_000)} MB`;

/** Settings → Search: the index over meetings and journals, and the model for search by meaning. */
export function SearchSettings() {
  const { data: status, isLoading, refetch } = useSearchStatus();

  const onError = (title: string) => (error: unknown) =>
    toast.error(title, {
      description: error instanceof Error ? error.message : String(error),
    });
  const download = useMutation({
    mutationFn: searchApi.downloadModel,
    onSettled: () => refetch(),
    onError: onError('Could not download the model'),
  });
  const remove = useMutation({
    mutationFn: searchApi.removeModel,
    onSettled: () => refetch(),
    onError: onError('Could not remove the model'),
  });
  const rebuild = useMutation({
    mutationFn: searchApi.rebuildIndex,
    onSuccess: () => toast.success('Search index rebuilt'),
    onSettled: () => refetch(),
    onError: onError('Could not rebuild the search index'),
  });

  if (isLoading || !status) {
    return <div className="py-10 text-center text-sm text-muted-foreground">Loading…</div>;
  }
  const { model } = status;
  const embeddedPct = status.chunks > 0 ? Math.round((status.embedded / status.chunks) * 100) : 0;

  return (
    <div className="space-y-6">
      <Card className="p-6">
        <h3 className="text-lg font-semibold text-foreground">Search</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Meeting and journal search runs entirely on this computer. It matches your words (including other forms of
          them, like “hire” and “hiring”) and, with the model below, what you mean, so “when did we push back the
          launch” finds a meeting where someone said “let’s move the release two weeks”. Dev Session agents search their
          docs the same way.
        </p>
        <dl className="mt-4 grid grid-cols-2 gap-4 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-muted-foreground">Indexed</dt>
            <dd className="font-medium text-foreground">
              {status.documents.toLocaleString()} {status.documents === 1 ? 'item' : 'items'}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Passages</dt>
            <dd className="font-medium text-foreground">{status.chunks.toLocaleString()}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Searchable by meaning</dt>
            <dd className="font-medium text-foreground">
              {model.loaded ? `${embeddedPct}%` : '—'}
              {model.loaded && embeddedPct < 100 && (
                <span className="ml-1 text-xs font-normal text-muted-foreground">(catching up in the background)</span>
              )}
            </dd>
          </div>
        </dl>
        <Button variant="outline" className="mt-5" onClick={() => rebuild.mutate()} disabled={rebuild.isPending}>
          {rebuild.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />} Rebuild index
        </Button>
      </Card>

      <Card className="p-6">
        <h3 className="flex items-center gap-2 text-lg font-semibold text-foreground">
          <Sparkles className="h-4 w-4 text-primary" /> Search by meaning
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          A small multilingual language model ({mb(model.sizeBytes)}) that runs locally. Without it, search matches
          words only. {model.loaded && 'Matches found by meaning are marked “related”.'}
        </p>

        <div className="mt-4 text-sm">
          {model.downloading ? (
            <div className="max-w-md space-y-2">
              <div className="text-foreground">
                Downloading… {mb(model.downloadedBytes)} of {mb(model.sizeBytes)}
              </div>
              <Progress value={(model.downloadedBytes / Math.max(1, model.sizeBytes)) * 100} />
            </div>
          ) : model.loaded ? (
            <div className="flex items-center gap-3">
              <Badge variant="success">On</Badge>
              <Button variant="ghost" size="sm" onClick={() => remove.mutate()} disabled={remove.isPending}>
                <Trash2 /> Remove model
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              {model.installed && !model.error && <div className="text-muted-foreground">Loading the model…</div>}
              {model.error && <div className="text-destructive">{model.error}</div>}
              <Button onClick={() => download.mutate()} disabled={download.isPending}>
                {download.isPending ? <Loader2 className="animate-spin" /> : <Download />}
                {model.installed ? 'Load model' : `Download (${mb(model.sizeBytes)})`}
              </Button>
              {model.declined && !model.installed && (
                <p className="text-xs text-muted-foreground">
                  You removed it earlier, so Riff won’t download it by itself.
                </p>
              )}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
