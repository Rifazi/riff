'use client';

import { Transcript, TranscriptSegmentData } from '@/types';
import { TranscriptView } from '@/components/TranscriptView';
import { VirtualizedTranscriptView } from '@/components/VirtualizedTranscriptView';
import { TranscriptButtonGroup } from './TranscriptButtonGroup';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { useMemo, useState } from 'react';

interface TranscriptPanelProps {
  transcripts: Transcript[];
  customPrompt: string;
  onPromptChange: (value: string) => void;
  /** Called when the user presses Done: regenerates the summary using the context. */
  onApplyContext?: (context: string) => Promise<void> | void;
  onCopyTranscript: () => void;
  onOpenMeetingFolder: () => Promise<void>;
  isRecording: boolean;
  disableAutoScroll?: boolean;

  // Optional pagination props (when using virtualization)
  usePagination?: boolean;
  segments?: TranscriptSegmentData[];
  hasMore?: boolean;
  isLoadingMore?: boolean;
  totalCount?: number;
  loadedCount?: number;
  onLoadMore?: () => void;

  // Retranscription props
  meetingId?: string;
  meetingFolderPath?: string | null;
  onRefetchTranscripts?: () => Promise<void>;
}

export function TranscriptPanel({
  transcripts,
  customPrompt,
  onPromptChange,
  onApplyContext,
  onCopyTranscript,
  onOpenMeetingFolder,
  isRecording,
  disableAutoScroll = false,
  usePagination = false,
  segments,
  hasMore,
  isLoadingMore,
  totalCount,
  loadedCount,
  onLoadMore,
  meetingId,
  meetingFolderPath,
  onRefetchTranscripts,
}: TranscriptPanelProps) {
  // Context box: "Done" collapses it to a preview and regenerates the summary with it
  const [isEditingContext, setIsEditingContext] = useState(true);
  const showContextEditor = isEditingContext || !customPrompt.trim();

  // Convert transcripts to segments if pagination is not used but we want virtualization
  const convertedSegments = useMemo(() => {
    if (usePagination && segments) {
      return segments;
    }
    // Convert transcripts to segments for virtualization
    return transcripts.map((t) => ({
      id: t.id,
      timestamp: t.audio_start_time ?? 0,
      endTime: t.audio_end_time,
      text: t.text,
      confidence: t.confidence,
    }));
  }, [transcripts, usePagination, segments]);

  return (
    <div className="flex h-full min-w-0 w-full bg-card flex-col relative @container">
      {/* Title area */}
      <div className="p-4 border-b border-border">
        <TranscriptButtonGroup
          transcriptCount={usePagination ? (totalCount ?? convertedSegments.length) : transcripts?.length || 0}
          onCopyTranscript={onCopyTranscript}
          onOpenMeetingFolder={onOpenMeetingFolder}
          meetingId={meetingId}
          meetingFolderPath={meetingFolderPath}
          onRefetchTranscripts={onRefetchTranscripts}
        />
      </div>

      {/* Transcript content - use virtualized view for better performance */}
      <div className="flex-1 overflow-hidden pb-4">
        <VirtualizedTranscriptView
          segments={convertedSegments}
          isRecording={isRecording}
          isPaused={false}
          isProcessing={false}
          isStopping={false}
          enableStreaming={false}
          showConfidence={true}
          disableAutoScroll={disableAutoScroll}
          hasMore={hasMore}
          isLoadingMore={isLoadingMore}
          totalCount={totalCount}
          loadedCount={loadedCount}
          onLoadMore={onLoadMore}
        />
      </div>

      {/* Custom prompt input at bottom of transcript section */}
      {!isRecording && convertedSegments.length > 0 && (
        <div className="p-2 border-t border-border">
          {showContextEditor ? (
            <>
              <Textarea
                placeholder="Add context for AI summary. For example people involved, meeting overview, objective etc..."
                className="w-full shadow-sm min-h-[80px] resize-y"
                value={customPrompt}
                onChange={(e) => onPromptChange(e.target.value)}
              />
              <div className="mt-2 flex justify-end">
                <Button
                  size="sm"
                  disabled={!customPrompt.trim()}
                  onClick={() => {
                    setIsEditingContext(false);
                    void onApplyContext?.(customPrompt);
                  }}
                >
                  Done
                </Button>
              </div>
            </>
          ) : (
            <div className="flex items-start gap-2">
              <p className="flex-1 text-sm text-muted-foreground whitespace-pre-wrap line-clamp-4">
                {customPrompt}
              </p>
              <Button size="sm" variant="outline" onClick={() => setIsEditingContext(true)}>
                Edit
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
