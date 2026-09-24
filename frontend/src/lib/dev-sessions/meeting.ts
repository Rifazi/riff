import { invoke } from '@tauri-apps/api/core';
import type { Transcript } from '@/types';
import type { MeetingSourceInput, SessionRecord } from './types';

interface MeetingTranscriptsPage {
  transcripts: Transcript[];
  total_count: number;
  has_more: boolean;
}

function formatOffset(seconds: number | undefined, fallback: string): string {
  if (seconds === undefined || seconds === null) return fallback;
  const total = Math.floor(seconds);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `[${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}]`;
}

/** The whole meeting transcript as timestamped plain text (not just the page loaded in the UI). */
export async function fetchFullTranscriptText(meetingId: string): Promise<string> {
  const first = await invoke<MeetingTranscriptsPage>('api_get_meeting_transcripts', { meetingId, limit: 1, offset: 0 });
  if (first.total_count === 0) return '';
  const all = await invoke<MeetingTranscriptsPage>('api_get_meeting_transcripts', {
    meetingId,
    limit: first.total_count,
    offset: 0,
  });
  return all.transcripts.map((t) => `${formatOffset(t.audio_start_time, t.timestamp)} ${t.text}`).join('\n');
}

export async function buildMeetingSource(input: {
  meetingId: string;
  meetingTitle: string;
  meetingCreatedAt?: string | null;
  summaryMarkdown?: string | null;
}): Promise<MeetingSourceInput> {
  const transcript = await fetchFullTranscriptText(input.meetingId);
  return {
    meetingId: input.meetingId,
    meetingTitle: input.meetingTitle,
    meetingDate: input.meetingCreatedAt ? new Date(input.meetingCreatedAt).toLocaleString() : null,
    transcript,
    summary: input.summaryMarkdown?.trim() || null,
  };
}

/**
 * Opening message for a session created from a meeting. The transcript
 * itself is attached server-side on this first turn, so this only has to
 * frame the task — and it has to carry the instructions itself, since an
 * app's prompt override replaces the requirements agent's base prompt.
 */
export function meetingKickoffMessage(session: SessionRecord): string {
  const source = session.sourceMeeting;
  const what = source?.includesSummary ? 'transcript and AI summary' : 'transcript';
  const title = source?.meetingTitle ? `"${source.meetingTitle}"` : 'a recorded meeting';
  const when = source?.meetingDate ? ` (${source.meetingDate})` : '';
  return [
    `I've attached the ${what} of the meeting ${title}${when}. Please turn what was discussed into requirements for this app:`,
    '',
    '1. Read the whole transcript and pull out the features, changes, problems and decisions that were discussed.',
    '2. Search the docs for related context before asking anything they already answer.',
    '3. Ask me about whatever is ambiguous, contradictory or missing — especially acceptance criteria and non-goals.',
    '4. Then write the requirements document.',
    '',
    'The transcript is automatic speech-to-text without speaker labels, so names and technical terms may be mis-transcribed — confirm anything important rather than guessing. Cite the meeting in the document\'s Links section.',
  ].join('\n');
}
