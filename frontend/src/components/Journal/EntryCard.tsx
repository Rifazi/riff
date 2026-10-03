"use client";

import Link from "next/link";
import {
  CalendarClock,
  ExternalLink,
  FolderInput,
  MoreHorizontal,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { meetingHref, type NotebookEntry } from "@/lib/journal/api";
import { formatClock, formatOffset } from "@/lib/journal/format";

interface EntryCardProps {
  entry: NotebookEntry;
  onMove: () => void;
  onRefile: () => void;
  onDelete: () => void;
}

/** One meeting's notes on the journal's topic. */
export function EntryCard({
  entry,
  onMove,
  onRefile,
  onDelete,
}: EntryCardProps) {
  const range = [formatOffset(entry.start_time), formatOffset(entry.end_time)]
    .filter(Boolean)
    .join("–");

  return (
    <Card className="group p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-semibold text-foreground">{entry.title}</h3>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
            <CalendarClock className="h-3 w-3" />
            <span>
              {formatClock(entry.meeting_started_at, entry.start_time)}
            </span>
            {range && <span>· {range} in recording</span>}
            <span>·</span>
            <Link
              href={meetingHref(entry.meeting_id)}
              className="inline-flex items-center gap-0.5 truncate hover:text-primary hover:underline"
            >
              {entry.meeting_title} <ExternalLink className="h-3 w-3" />
            </Link>
          </div>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground opacity-0 focus:opacity-100 group-hover:opacity-100"
              aria-label="Note actions"
            >
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onMove}>
              <FolderInput className="mr-2 h-4 w-4" /> Move to another journal
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onRefile}>
              <RefreshCw className="mr-2 h-4 w-4" /> Re-file this meeting
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={onDelete}
              className="text-destructive focus:text-destructive"
            >
              <Trash2 className="mr-2 h-4 w-4" /> Remove note
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-foreground/80">
        {entry.summary}
      </p>

      {entry.key_points.length > 0 && (
        <ul className="mt-3 space-y-1 border-l-2 border-border pl-3 text-sm text-foreground/80">
          {entry.key_points.map((point, i) => (
            <li key={i}>{point}</li>
          ))}
        </ul>
      )}
    </Card>
  );
}
