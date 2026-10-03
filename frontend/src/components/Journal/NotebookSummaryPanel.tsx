"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { journalApi, journalKeys, type Notebook } from "@/lib/journal/api";
import { formatDate } from "@/lib/journal/format";
import { JournalMarkdown } from "./JournalMarkdown";

interface NotebookSummaryPanelProps {
  notebook: Notebook;
  hasEntries: boolean;
  /** Entries were added after the summary was written. */
  stale: boolean;
}

export function NotebookSummaryPanel({
  notebook,
  hasEntries,
  stale,
}: NotebookSummaryPanelProps) {
  const queryClient = useQueryClient();
  const summarize = useMutation({
    mutationFn: () => journalApi.summarizeNotebook(notebook.id),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: journalKeys.all }),
  });

  if (!notebook.summary_markdown) {
    return (
      <div className="py-8 text-center">
        <Sparkles className="mx-auto h-8 w-8 text-gray-300" />
        <p className="mx-auto mt-2 max-w-xs text-sm text-gray-500">
          A quick read on where this topic stands, what was decided and what’s
          still open. It updates on its own as new meetings are added.
        </p>
        <Button
          className="mt-4"
          variant="default"
          disabled={!hasEntries || summarize.isPending}
          onClick={() => summarize.mutate()}
        >
          {summarize.isPending ? (
            <Loader2 className="animate-spin" />
          ) : (
            <Sparkles />
          )}
          {summarize.isPending ? "Writing overview…" : "Create overview"}
        </Button>
        {summarize.error && (
          <p className="mt-2 text-sm text-destructive">
            {String(summarize.error)}
          </p>
        )}
      </div>
    );
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-2 text-xs text-gray-500">
        <span>
          Updated {formatDate(notebook.summary_updated_at)}
          {stale && (
            <span className="ml-1 text-amber-700">
              · newer notes not included yet
            </span>
          )}
        </span>
        <Button
          size="sm"
          variant="outline"
          disabled={summarize.isPending}
          onClick={() => summarize.mutate()}
        >
          {summarize.isPending ? (
            <Loader2 className="animate-spin" />
          ) : (
            <Sparkles />
          )}
          {summarize.isPending ? "Refreshing…" : "Refresh"}
        </Button>
      </div>
      {summarize.error && (
        <p className="mb-2 text-sm text-destructive">
          {String(summarize.error)}
        </p>
      )}
      <JournalMarkdown markdown={notebook.summary_markdown} />
    </div>
  );
}
