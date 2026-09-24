'use client';

import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, ChevronRight, Paperclip, Send, Wrench, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { AttachmentInput, TranscriptEntry } from '@/lib/dev-sessions/types';
import type { AgentPersona } from '@/lib/dev-sessions/agents';

interface ChatPaneProps {
  entries: TranscriptEntry[];
  onSend: (message: string, attachments?: AttachmentInput[]) => void;
  disabled: boolean;
  placeholder?: string;
  /** True while an agent turn is actively streaming — shows a live "working" indicator. */
  streaming?: boolean;
  /** The tool name currently running, if any — surfaced in the live indicator. */
  runningTool?: string | null;
  /** Who's on the other end of this chat — shown in a header strip and the "working" indicator. */
  agent: AgentPersona;
  /** Shown instead of the default when there are no messages yet. */
  emptyHint?: string;
}

const ASK_MULTIPLE_CHOICE_TOOL = 'ask_multiple_choice';
const ASK_QUESTION_TOOL = 'ask_question';
// Any tool call in this set renders as its own answer box (buttons or a
// text field) instead of a generic collapsible tool-call bubble, and is
// batched into the same "answer everything asked since the last message"
// flow below.
const QUESTION_TOOL_NAMES = new Set([ASK_MULTIPLE_CHOICE_TOOL, ASK_QUESTION_TOOL]);

// Mirrors the cap in harness-server/backend/src/agents/attachments.ts —
// checked here too so an oversized file is rejected before a round trip.
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
const ACCEPTED_ATTACHMENT_TYPES = '.pdf,.txt,.md,.markdown,.csv,.json,.yml,.yaml,text/plain,text/markdown,application/pdf';

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      // result is "data:<mediaType>;base64,<data>" — the backend expects
      // only the payload after the comma.
      const result = reader.result as string;
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error(`Failed to read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

function stripToolPrefix(name: string | undefined): string {
  return (name ?? '').replace(/^mcp__[^_]+(-[^_]+)?__/, '');
}

// Models occasionally call ask_multiple_choice/ask_question twice with the
// literal same question in one batch — normalized so trivial whitespace
// differences still count as the same question.
function normalizedQuestionText(entry: TranscriptEntry): string | null {
  const input = entry.toolInput as { question?: unknown } | undefined;
  return typeof input?.question === 'string' ? input.question.trim().toLowerCase().replace(/\s+/g, ' ') : null;
}

// Best-effort one-line summary of a tool call's most relevant argument, so
// "what is the agent doing" is visible without expanding every bubble.
function summarizeToolInput(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;
  for (const key of ['path', 'query', 'message', 'command', 'branchName']) {
    const value = obj[key];
    if (typeof value === 'string') return key === 'query' ? `"${value}"` : value;
  }
  return null;
}

function AgentAvatar({ agent, size = 'md' }: { agent: AgentPersona; size?: 'sm' | 'md' }) {
  const dims = size === 'sm' ? 'w-6 h-6 text-[10px]' : 'w-9 h-9 text-xs';
  return (
    <div
      className={`${dims} flex-shrink-0 rounded-full bg-gradient-to-br from-blue-500 to-purple-500 text-white font-semibold flex items-center justify-center`}
      title={agent.fullName}
    >
      {agent.initials}
    </div>
  );
}

function ToolCallBubble({ entry }: { entry: TranscriptEntry }) {
  // Live SSE overlay entries (id "overlay-N", see useAgentTurnStream) open
  // by default so a running turn is visible; historical ones stay collapsed.
  const isLive = entry.id.startsWith('overlay-');
  const name = stripToolPrefix(entry.toolName);
  const summary = entry.role === 'tool_call' ? summarizeToolInput(entry.toolInput) : null;

  return (
    <details
      open={isLive}
      className={`group rounded-md border text-xs font-mono ${
        entry.isError ? 'border-red-200 bg-red-50 text-red-800' : 'border-gray-200 bg-gray-50 text-gray-600'
      }`}
    >
      <summary className="flex items-center gap-1.5 px-2.5 py-1.5 cursor-pointer select-none list-none">
        <ChevronRight className="w-3 h-3 transition-transform group-open:rotate-90 flex-shrink-0" />
        <Wrench className="w-3 h-3 flex-shrink-0" />
        <span className="truncate">
          {entry.role === 'tool_call' ? name || 'tool call' : 'result'}
          {summary ? ` — ${summary}` : ''}
          {entry.isError ? ' (error)' : ''}
        </span>
      </summary>
      <div className="px-2.5 pb-2 space-y-1 break-all whitespace-pre-wrap">
        {entry.toolInput !== undefined && <div>in: {JSON.stringify(entry.toolInput)}</div>}
        {entry.toolResult !== undefined && <div>out: {JSON.stringify(entry.toolResult).slice(0, 800)}</div>}
      </div>
    </details>
  );
}

interface DraftAnswer {
  option?: string;
  text: string;
}

function questionText(entry: TranscriptEntry): string {
  const input = entry.toolInput as { question?: unknown } | undefined;
  return typeof input?.question === 'string' ? input.question : '';
}

function questionOptions(entry: TranscriptEntry): string[] {
  if (stripToolPrefix(entry.toolName) === ASK_QUESTION_TOOL) return [];
  const input = entry.toolInput as { options?: unknown } | undefined;
  return Array.isArray(input?.options) ? input.options.filter((o): o is string => typeof o === 'string') : [];
}

function answerText(answer: DraftAnswer | undefined): string {
  if (!answer) return '';
  const text = answer.text.trim();
  if (answer.option && text) return `${answer.option} — ${text}`;
  return answer.option ?? text;
}

// One message for the whole batch, each answer paired with its full
// question, so the agent never has to guess what a bare "Yes" refers to.
function composeAnswers(questions: TranscriptEntry[], answers: Record<string, DraftAnswer>, note: string): string {
  const lines = questions.map((q, i) => {
    const answer = answerText(answers[q.id]);
    return `${i + 1}. ${questionText(q)}\n   Answer: ${answer || '(skipped — use your best judgment and record it as an assumption)'}`;
  });
  const intro = questions.length === 1 ? 'My answer to your question:' : 'My answers to your questions:';
  return `${intro}\n\n${lines.join('\n\n')}${note.trim() ? `\n\nAdditional note: ${note.trim()}` : ''}`;
}

// The agent's structured question. Pending ones are fully controlled by
// ChatPane (nothing sends until "Send answers"); answered ones from earlier
// turns render read-only so a stray click can't fire an out-of-context reply.
function QuestionBubble({
  entry,
  index,
  answer,
  onChange,
  disabled,
  readOnly,
}: {
  entry: TranscriptEntry;
  index?: number;
  answer?: DraftAnswer;
  onChange?: (answer: DraftAnswer) => void;
  disabled: boolean;
  readOnly: boolean;
}) {
  const question = questionText(entry);
  const options = questionOptions(entry);
  const isFreeform = stripToolPrefix(entry.toolName) === ASK_QUESTION_TOOL;

  if (!question || (!isFreeform && options.length === 0)) return <ToolCallBubble entry={entry} />;

  if (readOnly) {
    return (
      <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
        <div className="text-xs font-medium text-gray-500 mb-0.5">Question</div>
        <div className="text-sm text-gray-700">{question}</div>
        {options.length > 0 && <div className="mt-1 text-xs text-gray-500">Options: {options.join(' · ')}</div>}
      </div>
    );
  }

  const current = answer ?? { text: '' };
  const answered = Boolean(answerText(current));

  return (
    <div className={`rounded-lg border p-3 space-y-2.5 ${answered ? 'border-green-200 bg-green-50/50' : 'border-blue-200 bg-blue-50/60'}`}>
      <div className="flex items-start gap-2">
        <span
          className={`flex-shrink-0 w-5 h-5 rounded-full text-[11px] font-semibold flex items-center justify-center ${
            answered ? 'bg-green-600 text-white' : 'bg-blue-600 text-white'
          }`}
        >
          {answered ? <Check className="w-3 h-3" /> : (index ?? 0) + 1}
        </span>
        <div className="text-sm font-medium text-gray-900">{question}</div>
      </div>
      {options.length > 0 && (
        <div className="flex flex-wrap gap-2 pl-7">
          {options.map((option) => {
            const selected = option === current.option;
            return (
              <button
                key={option}
                type="button"
                onClick={() => onChange?.({ ...current, option: selected ? undefined : option })}
                disabled={disabled}
                className={`inline-flex items-center gap-1 px-3 py-1.5 rounded-md border text-sm text-left transition-colors disabled:opacity-50 ${
                  selected
                    ? 'bg-blue-600 border-blue-600 text-white'
                    : 'bg-white border-gray-200 text-gray-700 hover:border-blue-300 hover:bg-blue-50'
                }`}
              >
                {option}
                {selected && <Check className="w-3.5 h-3.5 flex-shrink-0" />}
              </button>
            );
          })}
        </div>
      )}
      <div className="pl-7">
        <textarea
          value={current.text}
          onChange={(e) => onChange?.({ ...current, text: e.target.value })}
          disabled={disabled}
          placeholder={options.length > 0 ? 'Optional: add detail, or type your own answer instead…' : 'Type your answer…'}
          rows={2}
          className="w-full px-3 py-2 border border-gray-200 rounded-md text-sm bg-white focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 resize-y disabled:opacity-50"
        />
      </div>
    </div>
  );
}

export function ChatPane({ entries, onSend, disabled, placeholder, streaming, runningTool, agent, emptyHint }: ChatPaneProps) {
  const [draft, setDraft] = useState('');
  const [pendingFiles, setPendingFiles] = useState<AttachmentInput[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Answers for the still-open batch of questions, keyed by tool_call entry
  // id. Never sent automatically — only by the explicit Send action.
  const [answers, setAnswers] = useState<Record<string, DraftAnswer>>({});
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [entries.length, streaming, runningTool]);

  // Every question tool call since the human's last message — the batch
  // currently awaiting a reply — deduped by question text.
  let lastUserIndex = -1;
  entries.forEach((e, i) => {
    if (e.role === 'user') lastUserIndex = i;
  });
  const seenQuestionText = new Set<string>();
  const duplicatePendingIds = new Set<string>();
  const pendingQuestions: TranscriptEntry[] = [];
  entries.forEach((e, i) => {
    if (i <= lastUserIndex || e.role !== 'tool_call' || !QUESTION_TOOL_NAMES.has(stripToolPrefix(e.toolName))) return;
    const text = normalizedQuestionText(e);
    if (text && seenQuestionText.has(text)) {
      duplicatePendingIds.add(e.id);
      return;
    }
    if (text) seenQuestionText.add(text);
    pendingQuestions.push(e);
  });
  // Questions can't be answered while the agent is still mid-turn (more may
  // be coming), so the batch only opens once the turn has finished.
  const batchOpen = !streaming && pendingQuestions.length > 0;
  const pendingIds = pendingQuestions.map((e) => e.id);
  const pendingKey = pendingIds.join('|');
  const answeredCount = pendingQuestions.filter((q) => answerText(answers[q.id])).length;

  useEffect(() => {
    setAnswers((prev) => {
      const next: Record<string, DraftAnswer> = {};
      for (const id of pendingIds) if (prev[id]) next[id] = prev[id];
      return next;
    });
    // pendingKey is a stable summary of pendingIds (a new array every render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingKey]);

  const canSend = !disabled && (draft.trim().length > 0 || pendingFiles.length > 0 || (batchOpen && answeredCount > 0));

  const send = () => {
    if (!canSend) return;
    let message: string;
    if (batchOpen && answeredCount > 0) {
      message = composeAnswers(pendingQuestions, answers, draft);
    } else {
      message =
        draft.trim() ||
        (pendingFiles.length === 1
          ? `See attached: ${pendingFiles[0].name}`
          : `See attached files: ${pendingFiles.map((f) => f.name).join(', ')}`);
    }
    onSend(message, pendingFiles.length ? pendingFiles : undefined);
    setDraft('');
    setPendingFiles([]);
    setAnswers({});
  };

  const handleFilesSelected = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    setAttachError(null);
    const files = Array.from(fileList);
    const oversized = files.find((f) => f.size > MAX_ATTACHMENT_BYTES);
    if (oversized) {
      setAttachError(`${oversized.name} is over the ${MAX_ATTACHMENT_BYTES / (1024 * 1024)}MB attachment limit.`);
      return;
    }
    try {
      const read = await Promise.all(
        files.map(async (file) => ({
          name: file.name,
          mediaType: file.type || 'application/octet-stream',
          data: await readFileAsBase64(file),
        }))
      );
      setPendingFiles((prev) => [...prev, ...read]);
    } catch (err) {
      setAttachError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-white rounded-lg border border-gray-200 shadow-sm">
      <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-100 flex-shrink-0">
        <AgentAvatar agent={agent} />
        <div className="min-w-0">
          <div className="text-sm font-semibold text-gray-900" title={agent.fullName}>
            {agent.name}
          </div>
          <div className="text-xs text-gray-500">{agent.title}</div>
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-4 py-4 space-y-3">
        {entries.length === 0 && !streaming && (
          <div className="py-8 text-center text-sm text-gray-500">{emptyHint ?? 'Say what you want to build.'}</div>
        )}
        {entries.map((entry, i) => {
          if (entry.role === 'user') {
            return (
              <div key={entry.id} className="flex justify-end">
                <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-blue-600 text-white px-3.5 py-2 text-sm whitespace-pre-wrap break-words">
                  {entry.text}
                </div>
              </div>
            );
          }
          if (entry.role === 'assistant') {
            return (
              <div key={entry.id} className="flex gap-2 items-start">
                <AgentAvatar agent={agent} size="sm" />
                <div className="max-w-[85%] min-w-0 rounded-2xl rounded-tl-sm bg-gray-100 text-gray-900 px-3.5 py-2 text-sm break-words">
                  <div className="prose prose-sm max-w-none prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-pre:my-2">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.text ?? ''}</ReactMarkdown>
                  </div>
                </div>
              </div>
            );
          }
          if (entry.role === 'tool_call') {
            if (duplicatePendingIds.has(entry.id)) return null;
            if (QUESTION_TOOL_NAMES.has(stripToolPrefix(entry.toolName))) {
              const index = pendingIds.indexOf(entry.id);
              const isPending = batchOpen && index >= 0;
              return (
                <QuestionBubble
                  key={entry.id}
                  entry={entry}
                  index={index}
                  answer={answers[entry.id]}
                  onChange={(answer) => setAnswers((prev) => ({ ...prev, [entry.id]: answer }))}
                  disabled={disabled}
                  readOnly={!isPending}
                />
              );
            }
            return <ToolCallBubble key={entry.id} entry={entry} />;
          }
          if (entry.role === 'tool_result') {
            // A question tool's result is a trivial placeholder — the
            // question bubble from the preceding tool_call already shows it.
            const prev = entries[i - 1];
            if (prev?.role === 'tool_call' && QUESTION_TOOL_NAMES.has(stripToolPrefix(prev.toolName))) return null;
            return <ToolCallBubble key={entry.id} entry={entry} />;
          }
          if (entry.role === 'system') {
            return (
              <div
                key={entry.id}
                className={`text-center text-xs px-3 py-1.5 rounded-md ${
                  entry.isError ? 'bg-red-50 text-red-700 border border-red-200' : 'text-gray-500'
                }`}
              >
                {entry.text}
              </div>
            );
          }
          return null;
        })}
        {streaming && (
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
            {runningTool ? `${agent.name} is running ${stripToolPrefix(runningTool)}…` : `${agent.name} is thinking…`}
          </div>
        )}
      </div>

      <div className="flex-shrink-0 border-t border-gray-100 p-3 space-y-2">
        {batchOpen && (
          <div className="flex items-center gap-3 rounded-md bg-blue-50 border border-blue-100 px-3 py-2">
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-gray-900">
                {answeredCount} of {pendingQuestions.length} question{pendingQuestions.length === 1 ? '' : 's'} answered
              </div>
              <div className="text-xs text-gray-500">
                {answeredCount < pendingQuestions.length
                  ? `Answer what you can — anything left blank is sent as "use your best judgment".`
                  : 'All answered — add a note below if you like, then send.'}
              </div>
            </div>
            <div className="h-1.5 w-24 rounded-full bg-blue-100 overflow-hidden flex-shrink-0">
              <div
                className="h-full bg-blue-600 transition-all"
                style={{ width: `${(answeredCount / pendingQuestions.length) * 100}%` }}
              />
            </div>
          </div>
        )}
        {attachError && <div className="text-xs text-red-600">{attachError}</div>}
        {pendingFiles.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {pendingFiles.map((f) => (
              <span
                key={f.name}
                className="inline-flex items-center gap-1 rounded-full border border-gray-200 bg-gray-50 pl-2 pr-1 py-0.5 text-xs text-gray-700"
              >
                <Paperclip className="w-3 h-3" />
                {f.name}
                <button
                  type="button"
                  onClick={() => setPendingFiles((prev) => prev.filter((p) => p.name !== f.name))}
                  disabled={disabled}
                  aria-label={`Remove ${f.name}`}
                  className="p-0.5 rounded-full hover:bg-gray-200"
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="flex gap-2 items-end">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={ACCEPTED_ATTACHMENT_TYPES}
            hidden
            onChange={(e) => {
              void handleFilesSelected(e.target.files);
              e.target.value = '';
            }}
          />
          <Button
            type="button"
            size="icon"
            variant="outline"
            title="Attach a PDF or text file"
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled}
          >
            <Paperclip />
          </Button>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // While answering questions, Enter is just a newline — answers only go out via the button.
              if (e.key === 'Enter' && !e.shiftKey && !batchOpen) {
                e.preventDefault();
                send();
              }
            }}
            placeholder={
              batchOpen && !disabled
                ? 'Optional: add a note to send with your answers…'
                : placeholder ?? 'Type a message…'
            }
            disabled={disabled}
            rows={2}
            className="flex-1 px-3 py-2 border border-gray-200 rounded-md text-sm bg-white shadow-sm focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 resize-none disabled:bg-gray-50 disabled:text-gray-400"
          />
          <Button variant="blue" onClick={send} disabled={!canSend}>
            <Send />
            {batchOpen && answeredCount > 0 ? `Send answer${answeredCount === 1 ? '' : 's'}` : 'Send'}
          </Button>
        </div>
      </div>
    </div>
  );
}
