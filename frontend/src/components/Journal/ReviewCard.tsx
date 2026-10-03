"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, Check, HelpCircle, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  journalApi,
  journalKeys,
  meetingHref,
  type JournalSuggestion,
  type NotebookEntry,
} from "@/lib/journal/api";
import { coverColor, describeMoment } from "@/lib/journal/format";

interface ReviewCardProps {
  entry: NotebookEntry;
  /** Hide the meeting line, e.g. when already on that meeting's page. */
  hideMeeting?: boolean;
}

/**
 * A part of a meeting the organizer wasn't sure where to file: shows its
 * question and lets the user pick a suggested journal, another journal, a new
 * one, or discard the part.
 */
export function ReviewCard({ entry, hideMeeting }: ReviewCardProps) {
  const queryClient = useQueryClient();
  const { data: journals = [] } = useQuery({
    queryKey: journalKeys.notebooks,
    queryFn: journalApi.listNotebooks,
  });
  const [mode, setMode] = useState<"suggestions" | "other" | "new">(
    "suggestions",
  );
  const [newTitle, setNewTitle] = useState("");
  const [expanded, setExpanded] = useState(false);

  const file = useMutation({
    mutationFn: (
      target:
        { notebookId: string } | { newTitle: string; newDescription?: string },
    ) => journalApi.fileEntry(entry.id, target),
    onSuccess: (_, target) => {
      queryClient.invalidateQueries({ queryKey: journalKeys.all });
      const title =
        "notebookId" in target
          ? journals.find((j) => j.id === target.notebookId)?.title
          : target.newTitle;
      toast.success(`Filed into ${title ?? "journal"}`);
    },
    onError: (e) => toast.error(String(e)),
  });
  const discard = useMutation({
    mutationFn: () => journalApi.deleteEntry(entry.id),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: journalKeys.all }),
    onError: (e) => toast.error(String(e)),
  });

  const choose = (suggestion: JournalSuggestion) =>
    file.mutate(
      suggestion.notebook_id
        ? { notebookId: suggestion.notebook_id }
        : {
            newTitle: suggestion.title,
            newDescription: suggestion.description ?? undefined,
          },
    );
  const busy = file.isPending || discard.isPending;

  return (
    <Card className="border-warning/40 p-4">
      <div className="flex items-start gap-2 text-sm font-medium text-amber-900">
        <HelpCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-500" />
        <span>
          {entry.question ?? "Which journal does this part belong in?"}
        </span>
      </div>

      <div className="mt-2 rounded-md bg-stone-50 px-3 py-2">
        <div className="text-sm font-semibold text-gray-900">{entry.title}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-gray-500">
          <CalendarClock className="h-3 w-3" />
          {!hideMeeting && (
            <>
              <Link
                href={meetingHref(entry.meeting_id)}
                className="hover:text-indigo-600 hover:underline"
              >
                {entry.meeting_title}
              </Link>
              <span>·</span>
            </>
          )}
          <span>
            {describeMoment(
              entry.meeting_started_at,
              entry.start_time,
              entry.end_time,
            )}
          </span>
        </div>
        <p
          className={`mt-1.5 whitespace-pre-line text-sm text-gray-700 ${expanded ? "" : "line-clamp-3"}`}
        >
          {entry.summary}
        </p>
        {entry.summary.length > 220 && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="mt-0.5 text-xs text-indigo-600 hover:underline"
          >
            {expanded ? "Show less" : "Show more"}
          </button>
        )}
      </div>

      {mode === "suggestions" && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {entry.suggestions.map((suggestion, i) => {
            const existing = suggestion.notebook_id
              ? journals.find((j) => j.id === suggestion.notebook_id)
              : null;
            const color = coverColor(existing?.color ?? "slate");
            return (
              <Button
                key={i}
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => choose(suggestion)}
                title={suggestion.description ?? undefined}
              >
                {existing ? (
                  <span className={`h-2 w-2 rounded-full ${color.dot}`} />
                ) : (
                  <Plus />
                )}
                {existing ? existing.title : `New: ${suggestion.title}`}
              </Button>
            );
          })}
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || journals.length === 0}
            onClick={() => setMode("other")}
          >
            Another journal…
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => setMode("new")}
          >
            <Plus /> New journal
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto text-gray-500 hover:text-destructive"
            disabled={busy}
            onClick={() => discard.mutate()}
            title="Not worth keeping"
          >
            <Trash2 /> Discard
          </Button>
        </div>
      )}

      {mode === "other" && (
        <div className="mt-3 flex items-center gap-2">
          <Select
            onValueChange={(notebookId) => file.mutate({ notebookId })}
            disabled={busy}
          >
            <SelectTrigger className="h-8 max-w-xs bg-white text-sm">
              <SelectValue placeholder="Choose a journal" />
            </SelectTrigger>
            <SelectContent>
              {journals.map((journal) => (
                <SelectItem key={journal.id} value={journal.id}>
                  {journal.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setMode("suggestions")}
          >
            Back
          </Button>
        </div>
      )}

      {mode === "new" && (
        <form
          className="mt-3 flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (newTitle.trim()) file.mutate({ newTitle: newTitle.trim() });
          }}
        >
          <Input
            autoFocus
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="Journal topic, e.g. Vendor Contracts"
            className="h-8 max-w-xs bg-white text-sm"
          />
          <Button
            size="sm"
            variant="default"
            type="submit"
            disabled={busy || !newTitle.trim()}
          >
            <Check /> File
          </Button>
          <Button
            size="sm"
            variant="ghost"
            type="button"
            onClick={() => setMode("suggestions")}
          >
            Back
          </Button>
        </form>
      )}
    </Card>
  );
}

/** Every part waiting for the user, across meetings. Renders nothing when there are none. */
export function ReviewInbox() {
  const { data: review = [] } = useQuery({
    queryKey: journalKeys.review,
    queryFn: journalApi.listReview,
  });
  if (review.length === 0) return null;

  return (
    <section className="mb-8">
      <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-gray-900">
        Needs your input <Badge variant="warning">{review.length}</Badge>
      </h2>
      <p className="mb-3 text-sm text-gray-500">
        Riff wasn’t sure where these parts of your meetings belong.
      </p>
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        {review.map((entry) => (
          <ReviewCard key={entry.id} entry={entry} />
        ))}
      </div>
    </section>
  );
}
