'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api } from '@/lib/dev-sessions/api';
import type { SettingsResponse } from '@/lib/dev-sessions/types';
import { ErrorText } from '../PageShell';
import { ConfirmDialog } from '../ConfirmDialog';
import { ModelCacheRow } from './ModelCacheRow';
import { formatBytes, totalCachedBytes } from './cache-size';

/**
 * Settings → Dev Agents controls for the agents' on-device `classify_text`
 * tool: which curated zero-shot model it runs, what each model costs on disk,
 * and a way to wipe the cache. Model files live under harness-server/state/,
 * so this is the only place they're managed.
 */
export function ClassificationToolSettings({ settings }: { settings: SettingsResponse }) {
  const queryClient = useQueryClient();
  const options = settings.classificationModels;
  const savedModel = settings.classification.model;

  const [model, setModel] = useState(savedModel);
  const [confirmingClear, setConfirmingClear] = useState(false);

  // Keep the picker in step with the server after a save or an external change.
  useEffect(() => setModel(savedModel), [savedModel]);

  const cache = useQuery({
    queryKey: ['classification-cache'],
    queryFn: api.getClassificationCache,
  });

  const saveMutation = useMutation({
    mutationFn: (next: string) => api.updateSettings({ classification: { model: next } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['settings'] }),
  });

  const clearMutation = useMutation({
    mutationFn: api.clearClassificationCache,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['classification-cache'] }),
  });

  const entries = cache.data?.models ?? [];
  const cachedTotal = totalCachedBytes(entries);
  const nothingCached = entries.length > 0 && cachedTotal === 0;
  const dirty = model !== savedModel;

  return (
    <div className="py-4 space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)] gap-3 items-center">
        <div>
          <div className="font-medium text-foreground">Classification model</div>
          <div className="text-xs text-muted-foreground">
            Runs on this machine, free after the first download. Takes effect on the agents&apos; next classification
            call — no restart.
          </div>
        </div>
        <div className="flex gap-2">
          <Select value={model} onValueChange={setModel} disabled={saveMutation.isPending}>
            <SelectTrigger className="flex-1">
              <SelectValue placeholder="Select a model" />
            </SelectTrigger>
            <SelectContent>
              {options.map((option) => (
                <SelectItem key={option.id} value={option.id}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            className="h-9"
            disabled={!dirty || saveMutation.isPending}
            onClick={() => saveMutation.mutate(model)}
          >
            {saveMutation.isPending ? <Loader2 className="animate-spin" /> : null}
            Save
          </Button>
        </div>
      </div>

      {saveMutation.isError && <ErrorText>Couldn&apos;t save the model: {errorText(saveMutation.error)}</ErrorText>}

      <div className="rounded-md border border-border bg-muted/40 px-3 py-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-xs font-medium text-foreground">
            Downloaded models
            {cachedTotal > 0 && <span className="text-muted-foreground"> · {formatBytes(cachedTotal)} on disk</span>}
          </div>
          <Button
            size="sm"
            variant="outline"
            className="h-9"
            disabled={cachedTotal === 0 || clearMutation.isPending}
            onClick={() => setConfirmingClear(true)}
          >
            {clearMutation.isPending ? <Loader2 className="animate-spin" /> : <Trash2 />}
            Clear cache
          </Button>
        </div>

        {cache.isLoading ? (
          <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
            <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden />
            Checking the cache…
          </div>
        ) : cache.isError ? (
          <div className="py-2">
            <div className="text-xs text-destructive">
              Couldn&apos;t read the model cache: {errorText(cache.error)}. Is the agent server running?
            </div>
            <Button size="sm" variant="outline" className="h-9 mt-2" onClick={() => void cache.refetch()}>
              Try again
            </Button>
          </div>
        ) : (
          <>
            {nothingCached && (
              <div className="py-2 text-xs text-muted-foreground">
                Nothing downloaded yet — the first classification call fetches the selected model.
              </div>
            )}
            <div className="divide-y divide-border">
              {options.map((option) => (
                <ModelCacheRow
                  key={option.id}
                  option={option}
                  entry={entries.find((entry) => entry.id === option.id)}
                  selected={option.id === savedModel}
                />
              ))}
            </div>
          </>
        )}

        {clearMutation.isError && (
          <ErrorText>Couldn&apos;t clear the cache: {errorText(clearMutation.error)}</ErrorText>
        )}
      </div>

      <ConfirmDialog
        open={confirmingClear}
        title="Clear the classification cache?"
        description="Deletes every downloaded classification model from harness-server/state. The next classification call re-downloads whichever model is selected."
        confirmLabel="Clear cache"
        destructive
        onCancel={() => setConfirmingClear(false)}
        onConfirm={() => {
          setConfirmingClear(false);
          clearMutation.mutate();
        }}
      />
    </div>
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}
