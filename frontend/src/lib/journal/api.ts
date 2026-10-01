import { invoke } from '@tauri-apps/api/core';

// Mirrors frontend/src-tauri/src/journal/{repository,service,commands}.rs

export interface Notebook {
  id: string;
  title: string;
  description: string | null;
  color: string;
  auto_created: boolean;
  summary_markdown: string | null;
  summary_updated_at: string | null;
  created_at: string;
  updated_at: string;
  /** About building or changing software, so it can start a Dev Session; null until classified. */
  is_software: boolean | null;
}

export interface NotebookOverview extends Notebook {
  entry_count: number;
  meeting_count: number;
  last_meeting_at: string | null;
  recent_entry_titles: string[];
  summary_stale: boolean;
}

/** A journal the organizer suggests for a part it wasn't sure about; no id = a journal that doesn't exist yet. */
export interface JournalSuggestion {
  notebook_id: string | null;
  title: string;
  description?: string | null;
}

export interface NotebookEntry {
  id: string;
  /** null while the part waits for the user to pick a journal. */
  notebook_id: string | null;
  meeting_id: string;
  title: string;
  summary: string;
  key_points: string[];
  /** Seconds from the start of the recording. */
  start_time: number | null;
  end_time: number | null;
  created_at: string;
  meeting_title: string;
  meeting_date: string;
  /** Estimated wall-clock start of the recording. */
  meeting_started_at: string;
  status: 'filed' | 'needs_review';
  confidence: number | null;
  question: string | null;
  suggestions: JournalSuggestion[];
  notebook_title: string | null;
  notebook_color: string | null;
}

export interface NotebookDetail {
  notebook: Notebook;
  entries: NotebookEntry[];
}

/**
 * `unfiled`: never filed (or interrupted); `awaiting_summary`: waiting for the meeting summary;
 * `pending`: queued; `needs_review`: filed, but some parts wait for the user to pick a journal.
 */
export type JournalStatus =
  | 'unfiled'
  | 'awaiting_summary'
  | 'pending'
  | 'processing'
  | 'completed'
  | 'needs_review'
  | 'failed'
  | 'skipped';

export interface MeetingJournalStatus {
  meeting_id: string;
  meeting_title: string;
  meeting_date: string;
  status: JournalStatus;
  error: string | null;
  entry_count: number;
  review_count: number;
}

export interface MeetingJournalTag {
  meeting_id: string;
  notebook_id: string;
  title: string;
  color: string;
}

export interface AskTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface AskSource {
  id: number;
  kind: 'note' | 'transcript';
  meeting_id: string;
  meeting_title: string;
  meeting_date: string;
  meeting_started_at: string;
  notebook_id: string | null;
  entry_title: string | null;
  start_time: number | null;
  end_time: number | null;
  excerpt: string;
}

export interface AskAnswer {
  answer: string;
  sources: AskSource[];
}

export interface JournalUpdatedPayload {
  meeting_id: string | null;
  status: JournalStatus | 'notebooks-changed';
  error: string | null;
}

export const JOURNAL_UPDATED_EVENT = 'journal-updated';

export const journalKeys = {
  all: ['journal'] as const,
  notebooks: ['journal', 'notebooks'] as const,
  notebook: (id: string) => ['journal', 'notebook', id] as const,
  statuses: ['journal', 'statuses'] as const,
  review: ['journal', 'review'] as const,
  meeting: (meetingId: string) => ['journal', 'meeting', meetingId] as const,
  tags: ['journal', 'tags'] as const,
};

export const journalApi = {
  listNotebooks: () => invoke<NotebookOverview[]>('journal_list_notebooks'),
  getNotebook: (notebookId: string) => invoke<NotebookDetail>('journal_get_notebook', { notebookId }),
  createNotebook: (title: string, description?: string) =>
    invoke<Notebook>('journal_create_notebook', { title, description }),
  updateNotebook: (notebookId: string, changes: { title?: string; description?: string; color?: string }) =>
    invoke<void>('journal_update_notebook', { notebookId, ...changes }),
  deleteNotebook: (notebookId: string) => invoke<void>('journal_delete_notebook', { notebookId }),
  mergeNotebooks: (sourceId: string, targetId: string) =>
    invoke<void>('journal_merge_notebooks', { sourceId, targetId }),
  /** Files a part into a journal (moving a note, or answering the organizer's question). Returns the journal id. */
  fileEntry: (entryId: string, target: { notebookId: string } | { newTitle: string; newDescription?: string }) =>
    invoke<string>('journal_move_entry', { entryId, ...target }),
  listReview: () => invoke<NotebookEntry[]>('journal_list_review'),
  requirementsBrief: (notebookId: string) =>
    invoke<{ covers: string; notes_markdown: string }>('journal_requirements_brief', { notebookId }),
  getMeetingTags: () => invoke<MeetingJournalTag[]>('journal_meeting_tags'),
  getMeetingEntries: (meetingId: string) => invoke<NotebookEntry[]>('journal_get_meeting_entries', { meetingId }),
  deleteEntry: (entryId: string) => invoke<void>('journal_delete_entry', { entryId }),
  organizeMeeting: (meetingId: string) => invoke<void>('journal_organize_meeting', { meetingId }),
  organizePending: () => invoke<number>('journal_organize_pending'),
  getMeetingStatuses: () => invoke<MeetingJournalStatus[]>('journal_get_meeting_statuses'),
  summarizeNotebook: (notebookId: string) =>
    invoke<{ summary_markdown: string; summary_updated_at: string }>('journal_summarize_notebook', { notebookId }),
  ask: (question: string, history: AskTurn[], notebookId?: string) =>
    invoke<AskAnswer>('journal_ask', { notebookId, question, history }),
};

export function notebookHref(id: string) {
  return `/journal/notebook?id=${encodeURIComponent(id)}`;
}

export function meetingHref(meetingId: string) {
  return `/meeting-details?id=${encodeURIComponent(meetingId)}`;
}
