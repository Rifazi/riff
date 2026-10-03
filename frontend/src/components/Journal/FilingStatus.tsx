"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Inbox,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { journalApi, journalKeys } from "@/lib/journal/api";
import { formatShortDate } from "@/lib/journal/format";

/** Shows meetings still waiting to be filed, filing in progress, and failures to retry. */
export function FilingStatus() {
  const queryClient = useQueryClient();
  const [showFailed, setShowFailed] = useState(false);
  const { data: statuses = [] } = useQuery({
    queryKey: journalKeys.statuses,
    queryFn: journalApi.getMeetingStatuses,
  });

  const fileAll = useMutation({
    mutationFn: journalApi.organizePending,
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: journalKeys.statuses }),
  });
  const retry = useMutation({
    mutationFn: journalApi.organizeMeeting,
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: journalKeys.statuses }),
  });

  const working = statuses.filter((s) => s.status === "processing");
  const awaiting = statuses.filter((s) => s.status === "awaiting_summary");
  const queued = statuses.filter((s) => s.status === "pending");
  const unfiled = statuses.filter((s) => s.status === "unfiled");
  const failed = statuses.filter((s) => s.status === "failed");

  if (
    [working, awaiting, queued, unfiled, failed].every(
      (list) => list.length === 0,
    )
  )
    return null;

  return (
    <div className="mb-6 space-y-2">
      {working.length > 0 && (
        <div className="flex items-center gap-2 rounded-lg border border-indigo-200 bg-indigo-50 px-4 py-2.5 text-sm text-indigo-800">
          <Loader2 className="h-4 w-4 animate-spin" />
          Filing “{working[0].meeting_title}” into journals…
          {queued.length > 0 && (
            <span className="text-indigo-600">
              ({queued.length} more queued)
            </span>
          )}
        </div>
      )}

      {working.length === 0 && awaiting.length > 0 && (
        <div className="flex items-center gap-2 rounded-lg border border-indigo-200 bg-indigo-50 px-4 py-2.5 text-sm text-indigo-800">
          <Loader2 className="h-4 w-4 animate-spin" />
          Summarizing “{awaiting[0].meeting_title}”, then filing its topics into
          journals…
        </div>
      )}

      {unfiled.length > 0 && (
        <Card className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm text-foreground">
          <span className="flex items-center gap-2">
            <Inbox className="h-4 w-4 text-muted-foreground" />
            {unfiled.length}{" "}
            {unfiled.length === 1 ? "meeting isn’t" : "meetings aren’t"} in your
            journals yet.
          </span>
          <Button
            size="sm"
            variant="default"
            disabled={fileAll.isPending}
            onClick={() => fileAll.mutate()}
          >
            File {unfiled.length === 1 ? "it" : "them"} now
          </Button>
        </Card>
      )}

      {failed.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-900">
          <button
            type="button"
            onClick={() => setShowFailed((v) => !v)}
            className="flex w-full items-center gap-2 text-left"
          >
            <AlertTriangle className="h-4 w-4" />
            <span className="flex-1">
              {failed.length} {failed.length === 1 ? "meeting" : "meetings"}{" "}
              couldn’t be filed.
            </span>
            {showFailed ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
          </button>
          {showFailed && (
            <ul className="mt-2 space-y-1.5">
              {failed.map((meeting) => (
                <li
                  key={meeting.meeting_id}
                  className="flex items-center justify-between gap-3 rounded-md bg-white/70 px-3 py-1.5"
                >
                  <span className="min-w-0">
                    <span className="font-medium">{meeting.meeting_title}</span>
                    <span className="text-amber-700">
                      {" "}
                      · {formatShortDate(meeting.meeting_date)}
                    </span>
                    {meeting.error && (
                      <span className="block truncate text-xs text-amber-800">
                        {meeting.error}
                      </span>
                    )}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={retry.isPending}
                    onClick={() => retry.mutate(meeting.meeting_id)}
                  >
                    <RefreshCw /> Retry
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
