"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import {
  ChevronRight,
  File,
  Mic,
  NotebookPen,
  Pencil,
  Search,
  Trash2,
  X,
} from "lucide-react";
import {
  useSidebar,
  type CurrentMeeting,
} from "@/components/Sidebar/SidebarProvider";
import { useRecordingState } from "@/contexts/RecordingStateContext";
import { ConfirmationModal } from "@/components/ConfirmationModel/confirmation-modal";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { VisuallyHidden } from "@/components/ui/visually-hidden";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  journalApi,
  journalKeys,
  type MeetingJournalTag,
} from "@/lib/journal/api";
import { coverColor } from "@/lib/journal/format";
import { MEETING_KINDS, useSearch } from "@/lib/search/api";
import { SearchHitLines } from "@/components/Search/SearchHitText";
import Analytics from "@/lib/analytics";

export default function MeetingsPage() {
  const router = useRouter();
  const {
    meetings,
    setMeetings,
    currentMeeting,
    setCurrentMeeting,
    handleRecordingToggle,
  } = useSidebar();
  const { isRecording } = useRecordingState();

  // Meetings flow straight into journals: tag each meeting with where its topics went.
  const { data: journalReview = [] } = useQuery({
    queryKey: journalKeys.review,
    queryFn: journalApi.listReview,
  });
  const { data: journalTags = [] } = useQuery({
    queryKey: journalKeys.tags,
    queryFn: journalApi.getMeetingTags,
  });
  const journalTagsByMeeting = useMemo(() => {
    const map = new Map<string, MeetingJournalTag[]>();
    for (const tag of journalTags)
      map.set(tag.meeting_id, [...(map.get(tag.meeting_id) ?? []), tag]);
    return map;
  }, [journalTags]);
  const reviewMeetingIds = useMemo(
    () => new Set(journalReview.map((e) => e.meeting_id)),
    [journalReview],
  );

  const [query, setQuery] = useState("");
  const [pendingDelete, setPendingDelete] = useState<CurrentMeeting | null>(
    null,
  );
  const [editing, setEditing] = useState<CurrentMeeting | null>(null);
  const [editingTitle, setEditingTitle] = useState("");

  // Titles, transcripts and summaries, best match first, one result per meeting.
  const { hits, isSearching } = useSearch(query, MEETING_KINDS);
  const matchesById = useMemo(
    () => new Map(hits.map((h) => [h.group, h])),
    [hits],
  );
  const visible = useMemo(() => {
    if (!query.trim()) return meetings;
    const byId = new Map(meetings.map((m) => [m.id, m]));
    return hits
      .map((h) => byId.get(h.group))
      .filter((m): m is CurrentMeeting => Boolean(m));
  }, [meetings, query, hits]);

  const openMeeting = (meeting: CurrentMeeting) => {
    setCurrentMeeting({ id: meeting.id, title: meeting.title });
    router.push(`/meeting-details?id=${meeting.id}`);
  };

  const handleDelete = async (meetingId: string) => {
    try {
      await invoke("api_delete_meeting", { meetingId });
      setMeetings(meetings.filter((m) => m.id !== meetingId));
      Analytics.trackMeetingDeleted(meetingId);
      toast.success("Meeting deleted successfully", {
        description: "All associated data has been removed",
      });
      if (currentMeeting?.id === meetingId)
        setCurrentMeeting({ id: "intro-call", title: "+ New Call" });
    } catch (error) {
      console.error("Failed to delete meeting:", error);
      toast.error("Failed to delete meeting", {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const startEdit = (meeting: CurrentMeeting) => {
    setEditing(meeting);
    setEditingTitle(meeting.title);
  };

  const cancelEdit = () => {
    setEditing(null);
    setEditingTitle("");
  };

  const confirmEdit = async () => {
    const newTitle = editingTitle.trim();
    if (!editing) return;
    if (!newTitle) {
      toast.error("Meeting title cannot be empty");
      return;
    }
    try {
      await invoke("api_save_meeting_title", {
        meetingId: editing.id,
        title: newTitle,
      });
      setMeetings(
        meetings.map((m) =>
          m.id === editing.id ? { ...m, title: newTitle } : m,
        ),
      );
      if (currentMeeting?.id === editing.id)
        setCurrentMeeting({ id: editing.id, title: newTitle });
      Analytics.trackButtonClick("edit_meeting_title", "meetings_page");
      toast.success("Meeting title updated successfully");
      cancelEdit();
    } catch (error) {
      console.error("Failed to update meeting title:", error);
      toast.error("Failed to update meeting title", {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return (
    <div className="h-screen bg-background flex flex-col min-w-0">
      <div className="flex-shrink-0 border-b border-border bg-background">
        <div className="px-8 py-5 flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold text-foreground truncate">
              Meeting Notes
            </h1>
            <div className="mt-1 text-sm text-muted-foreground">
              {meetings.length > 0
                ? `${meetings.length} ${meetings.length === 1 ? "meeting" : "meetings"} with transcripts and summaries`
                : "Every recording is transcribed and summarized here"}
            </div>
          </div>
          <Button
            variant="default"
            onClick={handleRecordingToggle}
            disabled={isRecording}
          >
            <Mic /> {isRecording ? "Recording in progress…" : "Start recording"}
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto custom-scrollbar">
        <div className="max-w-6xl mx-auto px-8 py-6">
          {meetings.length > 0 && (
            <div className="relative mb-6 max-w-md">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search titles, transcripts and summaries…"
                className="pl-9 pr-9"
              />
              {query && (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setQuery("")}
                  className="absolute right-1 top-1/2 h-7 w-7 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  aria-label="Clear search"
                >
                  <X className="h-4 w-4" />
                </Button>
              )}
              {query && isSearching && (
                <span className="absolute -bottom-5 left-1 text-xs text-primary animate-pulse">
                  Searching…
                </span>
              )}
            </div>
          )}

          {meetings.length === 0 && (
            <div className="rounded-xl border border-dashed border-border bg-card py-16 text-center">
              <NotebookPen className="mx-auto h-10 w-10 text-muted-foreground" />
              <h2 className="mt-3 font-semibold text-foreground">
                No meetings yet
              </h2>
              <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
                Record a meeting and its transcript and summary show up here.
              </p>
            </div>
          )}

          <div className="space-y-2">
            {visible.map((meeting) => {
              const match = query.trim()
                ? matchesById.get(meeting.id)
                : undefined;
              return (
                <Card
                  key={meeting.id}
                  onClick={() => openMeeting(meeting)}
                  className="group flex items-center gap-4 px-4 py-3 cursor-pointer transition-all hover:border-primary/40 hover:shadow-md"
                >
                  <div className="flex-shrink-0 flex items-center justify-center w-8 h-8 rounded-full bg-muted">
                    <File className="w-4 h-4 text-muted-foreground" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-foreground truncate">
                      {meeting.title}
                    </div>
                    <MeetingJournalDots
                      tags={journalTagsByMeeting.get(meeting.id)}
                      needsInput={reviewMeetingIds.has(meeting.id)}
                    />
                    {match && <SearchHitLines hit={match} />}
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-primary hover:bg-primary/10"
                      onClick={(e) => {
                        e.stopPropagation();
                        startEdit(meeting);
                      }}
                      aria-label="Edit meeting title"
                    >
                      <Pencil />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-destructive hover:bg-destructive/10"
                      onClick={(e) => {
                        e.stopPropagation();
                        setPendingDelete(meeting);
                      }}
                      aria-label="Delete meeting"
                    >
                      <Trash2 />
                    </Button>
                    <ChevronRight className="w-4 h-4 text-muted-foreground/50 group-hover:text-muted-foreground" />
                  </div>
                </Card>
              );
            })}
          </div>
          {meetings.length > 0 && visible.length === 0 && !isSearching && (
            <div className="py-10 text-center text-sm text-muted-foreground">
              No meetings match “{query}”.
            </div>
          )}
        </div>
      </div>

      <ConfirmationModal
        isOpen={Boolean(pendingDelete)}
        text="Are you sure you want to delete this meeting? This action cannot be undone."
        onConfirm={() => {
          if (pendingDelete) handleDelete(pendingDelete.id);
          setPendingDelete(null);
        }}
        onCancel={() => setPendingDelete(null)}
      />

      <Dialog
        open={Boolean(editing)}
        onOpenChange={(open) => !open && cancelEdit()}
      >
        <DialogContent className="sm:max-w-[425px]">
          <VisuallyHidden>
            <DialogTitle>Edit Meeting Title</DialogTitle>
          </VisuallyHidden>
          <div className="py-4">
            <h3 className="text-lg font-semibold mb-4">Edit Meeting Title</h3>
            <label
              htmlFor="meeting-title"
              className="block text-sm font-medium text-foreground mb-2"
            >
              Meeting Title
            </label>
            <Input
              id="meeting-title"
              type="text"
              value={editingTitle}
              onChange={(e) => setEditingTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") confirmEdit();
                else if (e.key === "Escape") cancelEdit();
              }}
              placeholder="Enter meeting title"
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={cancelEdit}>
              Cancel
            </Button>
            <Button variant="default" onClick={confirmEdit}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Colored dots for the journals a meeting's topics were filed into. */
function MeetingJournalDots({
  tags,
  needsInput,
}: {
  tags?: MeetingJournalTag[];
  needsInput: boolean;
}) {
  if (!tags?.length && !needsInput) return null;
  const shown = tags?.slice(0, 3) ?? [];
  const extra = (tags?.length ?? 0) - shown.length;
  return (
    <span className="mt-0.5 flex items-center gap-2 text-xs font-normal text-muted-foreground">
      {shown.map((tag) => (
        <span
          key={tag.notebook_id}
          className="flex min-w-0 items-center gap-1"
          title={`Filed in ${tag.title}`}
        >
          <span
            className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${coverColor(tag.color).dot}`}
          />
          <span className="max-w-[10rem] truncate">{tag.title}</span>
        </span>
      ))}
      {extra > 0 && <span>+{extra}</span>}
      {needsInput && (
        <Badge
          variant="warning"
          className="rounded px-1 py-0"
          title="Some topics need your input"
        >
          ?
        </Badge>
      )}
    </span>
  );
}
