'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useMutation } from '@tanstack/react-query';
import {
  ArrowUp,
  CalendarClock,
  ExternalLink,
  Loader2,
  MessageCircleQuestion,
  NotebookText,
  Quote,
  RotateCcw,
} from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { journalApi, meetingHref, type AskSource, type AskTurn } from '@/lib/journal/api';
import { describeMoment } from '@/lib/journal/format';
import { JournalMarkdown } from './JournalMarkdown';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  sources?: AskSource[];
  error?: boolean;
}

const SUGGESTIONS = [
  'What decisions have been made so far?',
  'What are the open action items, and who owns them?',
  'What changed in the most recent meeting?',
];

interface AskPanelProps {
  /** Omit to ask across the whole journal. */
  notebookId?: string;
  placeholder?: string;
}

export function AskPanel({ notebookId, placeholder }: AskPanelProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);

  // A new journal is a new conversation.
  useEffect(() => setMessages([]), [notebookId]);

  const askMutation = useMutation({
    mutationFn: ({ question, history }: { question: string; history: AskTurn[] }) =>
      journalApi.ask(question, history, notebookId),
    onSuccess: (answer) =>
      setMessages((prev) => [...prev, { role: 'assistant', content: answer.answer, sources: answer.sources }]),
    onError: (error) => setMessages((prev) => [...prev, { role: 'assistant', content: String(error), error: true }]),
  });

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, askMutation.isPending]);

  const send = (text: string) => {
    const question = text.trim();
    if (!question || askMutation.isPending) return;
    const history: AskTurn[] = messages.filter((m) => !m.error).map(({ role, content }) => ({ role, content }));
    setMessages((prev) => [...prev, { role: 'user', content: question }]);
    setDraft('');
    askMutation.mutate({ question, history });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex-1 min-h-0 space-y-4 overflow-y-auto custom-scrollbar pr-1">
        {messages.length === 0 && (
          <div className="py-6 text-center">
            <MessageCircleQuestion className="mx-auto h-8 w-8 text-muted-foreground/50" />
            <p className="mt-2 text-sm text-muted-foreground">
              Ask anything about {notebookId ? 'this journal' : 'your journals'}. Answers come only from your meetings,
              with the date and moment each point was said.
            </p>
            <div className="mt-4 flex flex-col items-center gap-2">
              {SUGGESTIONS.map((suggestion) => (
                <Button
                  key={suggestion}
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => send(suggestion)}
                  className="rounded-full px-3 text-xs font-normal"
                >
                  {suggestion}
                </Button>
              ))}
            </div>
          </div>
        )}

        {messages.map((message, index) =>
          message.role === 'user' ? (
            <div key={index} className="flex justify-end">
              <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-primary px-3.5 py-2 text-sm text-primary-foreground">
                {message.content}
              </div>
            </div>
          ) : (
            <AnswerBubble key={index} message={message} />
          ),
        )}

        {askMutation.isPending && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Reading your meetings…
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <form
        className="mt-3 flex-shrink-0"
        onSubmit={(e) => {
          e.preventDefault();
          send(draft);
        }}
      >
        <div className="relative">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send(draft);
              }
            }}
            rows={2}
            placeholder={placeholder ?? 'Ask a question…'}
            className="resize-none bg-background pr-12"
          />
          <Button
            type="submit"
            size="icon"
            variant="default"
            disabled={!draft.trim() || askMutation.isPending}
            className="absolute bottom-2 right-2 h-8 w-8 rounded-full"
            aria-label="Ask"
          >
            <ArrowUp />
          </Button>
        </div>
        {messages.length > 0 && (
          <button
            type="button"
            onClick={() => setMessages([])}
            className="mt-1.5 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <RotateCcw className="h-3 w-3" /> New conversation
          </button>
        )}
      </form>
    </div>
  );
}

function AnswerBubble({ message }: { message: Message }) {
  const [active, setActive] = useState<number | null>(null);
  const sources = message.sources ?? [];
  const citedIds = new Set(sources.map((s) => s.id));

  if (message.error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{message.content}</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="rounded-2xl rounded-bl-sm border border-border bg-card px-4 py-3">
      <JournalMarkdown
        markdown={message.content}
        citedIds={citedIds}
        onCite={(id) => setActive((current) => (current === id ? null : id))}
      />
      {sources.length > 0 && (
        <div className="mt-3 space-y-1.5 border-t border-border pt-3">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Sources</div>
          {sources.map((source) => (
            <SourceCard
              key={source.id}
              source={source}
              expanded={active === source.id}
              onToggle={() => setActive((current) => (current === source.id ? null : source.id))}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SourceCard({ source, expanded, onToggle }: { source: AskSource; expanded: boolean; onToggle: () => void }) {
  return (
    <div
      className={`rounded-lg border text-xs transition-colors ${expanded ? 'border-primary/30 bg-primary/5' : 'border-border bg-muted/50'}`}
    >
      <button type="button" onClick={onToggle} className="flex w-full items-start gap-2 px-2.5 py-2 text-left">
        <span className="mt-px inline-flex h-4 min-w-4 items-center justify-center rounded bg-primary/15 px-1 text-[10px] font-semibold text-primary">
          {source.id}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1 font-medium text-foreground">
            {source.kind === 'note' ? (
              <NotebookText className="h-3 w-3 flex-shrink-0" />
            ) : (
              <Quote className="h-3 w-3 flex-shrink-0" />
            )}
            <span className="truncate">{source.entry_title ?? source.meeting_title}</span>
          </span>
          <span className="mt-0.5 flex items-center gap-1 text-muted-foreground">
            <CalendarClock className="h-3 w-3 flex-shrink-0" />
            {source.entry_title && <span className="truncate">{source.meeting_title} ·</span>}
            <span className="whitespace-nowrap">
              {describeMoment(source.meeting_started_at, source.start_time, source.end_time)}
            </span>
          </span>
        </span>
      </button>
      {expanded && (
        <div className="px-2.5 pb-2.5">
          <p className="whitespace-pre-wrap rounded-md bg-background p-2 leading-relaxed text-foreground">
            {source.excerpt}
          </p>
          <Link
            href={meetingHref(source.meeting_id)}
            className="mt-1.5 inline-flex items-center gap-1 text-primary hover:underline"
          >
            Open meeting <ExternalLink className="h-3 w-3" />
          </Link>
        </div>
      )}
    </div>
  );
}
