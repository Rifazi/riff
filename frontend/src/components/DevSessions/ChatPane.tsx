'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, ChevronRight, FileCode, FileText, GitBranch, Package, Paperclip, Search, Send, Terminal, Wrench, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import type { AttachmentInput, HelperRunStats, TranscriptEntry } from '@/lib/dev-sessions/types';
import type { AgentPersona } from '@/lib/dev-sessions/agents';
import { ACCEPTED_ATTACHMENT_TYPES, readAttachments } from '@/lib/dev-sessions/attachments';
import { HelperBubble, helperFor, helperStatsBefore } from './HelperBubbles';

interface ChatPaneProps {
  entries: TranscriptEntry[];
  /** Omitted for a read-only log (see readOnly). */
  onSend?: (message: string, attachments?: AttachmentInput[]) => void;
  disabled: boolean;
  /** A log to read, not a conversation: no composer, just readOnlyNote in its place. */
  readOnly?: boolean;
  readOnlyNote?: React.ReactNode;
  /** Right-aligned controls in the header strip (status, expand…). */
  headerActions?: React.ReactNode;
  /** Extra classes for the outer card, e.g. to drop its border inside a dialog. */
  className?: string;
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

/** Pull plain text out of a tool result regardless of which engine produced it. */
function resultText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (Array.isArray(result))
    return result.map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : '')).join('\n');
  return JSON.stringify(result ?? '');
}

type ToolIcon = typeof Wrench;
function toolIcon(name: string): ToolIcon {
  if (name === 'search_code' || name === 'search_docs') return Search;
  if (name === 'read_file' || name === 'outline_file' || name === 'read_doc') return FileText;
  if (name === 'write_file' || name === 'edit_file') return FileCode;
  if (name.startsWith('run_') || name === 'get_diff') return Terminal;
  if (name === 'git_create_branch') return GitBranch;
  if (name === 'run_npm_install') return Package;
  return Wrench;
}

function resultBadge(name: string, input: unknown, text: string, isError: boolean): string | null {
  if (isError) return '✗ error';
  if (!text.trim()) return null;
  switch (name) {
    case 'search_code': {
      // Grouped output: file headers are non-indented lines
      const files = text.split('\n').filter((l) => l && !l.startsWith(' ')).length;
      return files === 0 ? 'no results' : `${files} file${files === 1 ? '' : 's'}`;
    }
    case 'read_file': {
      const lines = text.split('\n').length;
      return `${lines} line${lines === 1 ? '' : 's'}`;
    }
    case 'outline_file': {
      const items = text.split('\n').filter(Boolean).length;
      return `${items} items`;
    }
    case 'edit_file': {
      const inp = input as Record<string, unknown> | null;
      const n = Array.isArray(inp?.edits) ? inp.edits.length : null;
      return n !== null ? `${n} edit${n === 1 ? '' : 's'}` : '✓';
    }
    case 'write_file': return '✓ written';
    case 'run_npm_install': return '✓ installed';
    case 'run_prettier': return '✓ formatted';
    case 'git_create_branch': return '✓ created';
    case 'write_plan_doc': return '✓ saved';
    case 'run_checked_command': {
      const lower = text.toLowerCase();
      return lower.includes(' failed') || lower.includes('error') || lower.includes('✗') ? '✗ failed' : '✓ passed';
    }
    case 'get_diff': {
      const files = (text.match(/^### /gm) ?? []).length;
      return files ? `${files} file${files === 1 ? '' : 's'}` : null;
    }
    case 'assign_team': {
      const inp = input as Record<string, unknown> | null;
      const n = Array.isArray(inp?.workstreams) ? inp.workstreams.length : null;
      return n !== null ? `${n} workstreams` : '✓';
    }
    default: return null;
  }
}

// Key input fields shown in the expanded body — readable labels, not raw JSON.
function ToolInputRows({ name, input }: { name: string; input: unknown }) {
  const obj = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : null;
  if (!obj) return null;
  const rows: [string, string][] = [];
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  const num = (v: unknown) => (typeof v === 'number' ? String(v) : null);

  switch (name) {
    case 'search_code':
      if (str(obj.query)) rows.push(['Query', str(obj.query)!]);
      if (str(obj.glob)) rows.push(['In', str(obj.glob)!]);
      if (num(obj.context)) rows.push(['Context', num(obj.context)!]);
      break;
    case 'search_docs':
    case 'read_doc':
      if (str(obj.query ?? obj.path)) rows.push(['Query', str(obj.query ?? obj.path)!]);
      break;
    case 'read_file':
      if (str(obj.path)) rows.push(['File', str(obj.path)!]);
      if (num(obj.offset)) rows.push(['From line', num(obj.offset)!]);
      if (num(obj.limit)) rows.push(['Lines', num(obj.limit)!]);
      break;
    case 'outline_file':
    case 'write_file':
      if (str(obj.path)) rows.push(['File', str(obj.path)!]);
      break;
    case 'edit_file':
      if (str(obj.path)) rows.push(['File', str(obj.path)!]);
      if (Array.isArray(obj.edits)) rows.push(['Edits', String(obj.edits.length)]);
      break;
    case 'run_checked_command':
      if (str(obj.command)) rows.push(['Command', str(obj.command)!]);
      break;
    case 'git_create_branch':
      if (str(obj.branchName)) rows.push(['Branch', str(obj.branchName)!]);
      break;
    case 'fetch_url':
      if (str(obj.url)) rows.push(['URL', str(obj.url)!]);
      break;
    case 'write_qa_report':
      if (str(obj.result)) rows.push(['Result', str(obj.result)!]);
      break;
    default:
      for (const [k, v] of Object.entries(obj).slice(0, 3)) {
        const s = str(v) ?? num(v);
        if (s) rows.push([k, s]);
      }
  }

  if (!rows.length) return null;
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
      {rows.map(([k, v]) => (
        <React.Fragment key={k}>
          <dt className="text-muted-foreground/60 whitespace-nowrap">{k}</dt>
          <dd className="font-mono break-all truncate">{v}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

function ResultPreview({ text, name }: { text: string; name: string }) {
  const [showFull, setShowFull] = useState(false);
  const PREVIEW = 600;
  const trimmed = showFull ? text : text.slice(0, PREVIEW);
  const isCode = ['read_file', 'get_diff', 'search_code', 'outline_file', 'run_checked_command', 'run_npm_install', 'read_doc'].includes(name);
  return (
    <div className={`${isCode ? 'font-mono' : 'font-sans'} whitespace-pre-wrap break-all`}>
      {trimmed}
      {text.length > PREVIEW && (
        <button type="button" onClick={() => setShowFull((v) => !v)} className="ml-1 text-primary hover:underline not-italic font-sans">
          {showFull ? 'show less' : `… +${(text.length - PREVIEW).toLocaleString()} chars`}
        </button>
      )}
    </div>
  );
}

const ASK_MULTIPLE_CHOICE_TOOL = 'ask_multiple_choice';
const ASK_QUESTION_TOOL = 'ask_question';
// Any tool call in this set renders as its own answer box (buttons or a
// text field) instead of a generic collapsible tool-call bubble, and is
// batched into the same "answer everything asked since the last message"
// flow below.
const QUESTION_TOOL_NAMES = new Set([ASK_MULTIPLE_CHOICE_TOOL, ASK_QUESTION_TOOL]);

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

export function AgentAvatar({ agent, size = 'md' }: { agent: AgentPersona; size?: 'xs' | 'sm' | 'md' }) {
  const dims = size === 'xs' ? 'w-5 h-5 text-[9px]' : size === 'sm' ? 'w-6 h-6 text-[10px]' : 'w-9 h-9 text-xs';
  return (
    <div
      className={`${dims} flex-shrink-0 rounded-full bg-gradient-to-br ${agent.gradient ?? 'from-primary to-primary/60'} text-primary-foreground font-semibold flex items-center justify-center`}
      title={agent.fullName}
    >
      {agent.initials}
    </div>
  );
}

// Long chats render only their most recent entries until the human asks for
// more: a few hundred markdown bubbles make every update slow.
const VISIBLE_ENTRIES_STEP = 120;

function ToolCallBubble({ entry, result }: { entry: TranscriptEntry; result?: TranscriptEntry }) {
  // Live SSE overlay entries open by default; historical ones stay collapsed.
  const [open, setOpen] = useState(() => entry.id.startsWith('overlay-'));
  const name = stripToolPrefix(entry.toolName);
  const isError = result?.isError ?? entry.isError ?? false;
  const keyArg = summarizeToolInput(entry.toolInput);
  const rText = result ? resultText(result.toolResult) : null;
  const badge = rText !== null ? resultBadge(name, entry.toolInput, rText, isError) : null;
  const Icon = toolIcon(name);

  return (
    <details
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
      className={`group rounded-md border text-xs font-mono ${
        isError
          ? 'border-destructive/30 bg-destructive/10 text-destructive'
          : 'border-border bg-muted/60 text-muted-foreground'
      }`}
    >
      <summary className="flex items-center gap-1.5 px-2.5 py-1.5 cursor-pointer select-none list-none">
        <ChevronRight className="w-3 h-3 transition-transform group-open:rotate-90 flex-shrink-0 opacity-50" />
        <Icon className="w-3 h-3 flex-shrink-0 opacity-70" />
        <span className="font-medium">{name}</span>
        {keyArg && <span className="opacity-50 truncate">{keyArg}</span>}
        {badge && (
          <span className={`ml-auto pl-2 flex-shrink-0 text-[10px] font-mono ${isError ? 'text-destructive' : 'opacity-50'}`}>
            {badge}
          </span>
        )}
      </summary>
      {open && (
        <div className="px-3 pb-2.5 pt-1 font-sans space-y-2">
          <ToolInputRows name={name} input={entry.toolInput} />
          {rText && (
            <div className={`${rText && entry.toolInput !== undefined ? 'border-t border-border/30 pt-2' : ''} text-xs ${isError ? 'text-destructive' : 'text-muted-foreground'}`}>
              <ResultPreview text={rText} name={name} />
            </div>
          )}
        </div>
      )}
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
      <div className="rounded-lg border border-border bg-muted px-3 py-2">
        <div className="text-xs font-medium text-muted-foreground mb-0.5">Question</div>
        <div className="text-sm text-foreground">{question}</div>
        {options.length > 0 && <div className="mt-1 text-xs text-muted-foreground">Options: {options.join(' · ')}</div>}
      </div>
    );
  }

  const current = answer ?? { text: '' };
  const answered = Boolean(answerText(current));

  return (
    <div
      className={`rounded-lg border p-3 space-y-2.5 ${
        answered ? 'border-success/40 bg-success/10' : 'border-primary/40 bg-primary/10'
      }`}
    >
      <div className="flex items-start gap-2">
        <span
          className={`flex-shrink-0 w-5 h-5 rounded-full text-[11px] font-semibold flex items-center justify-center ${
            answered ? 'bg-success text-success-foreground' : 'bg-primary text-primary-foreground'
          }`}
        >
          {answered ? <Check className="w-3 h-3" /> : (index ?? 0) + 1}
        </span>
        <div className="text-sm font-medium text-foreground">{question}</div>
      </div>
      {options.length > 0 && (
        <div className="flex flex-wrap gap-2 pl-7">
          {options.map((option) => {
            const selected = option === current.option;
            return (
              <button
                key={option}
                type="button"
                onClick={() =>
                  onChange?.({
                    ...current,
                    option: selected ? undefined : option,
                  })
                }
                disabled={disabled}
                className={`inline-flex items-center gap-1 px-3 py-1.5 rounded-md border text-sm text-left transition-colors disabled:opacity-50 ${
                  selected
                    ? 'bg-primary border-primary text-primary-foreground'
                    : 'bg-card border-border text-foreground hover:border-primary/40 hover:bg-primary/10'
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
        <Textarea
          value={current.text}
          onChange={(e) => onChange?.({ ...current, text: e.target.value })}
          disabled={disabled}
          placeholder={
            options.length > 0 ? 'Optional: add detail, or type your own answer instead…' : 'Type your answer…'
          }
          rows={2}
          className="min-h-0 resize-y"
        />
      </div>
    </div>
  );
}

interface ChatEntryProps {
  entry: TranscriptEntry;
  agent: AgentPersona;
  /** Position in the open question batch, or -1. */
  questionIndex: number;
  /** Part of the batch currently awaiting an answer. */
  questionPending: boolean;
  answer?: DraftAnswer;
  onAnswer: (id: string, answer: DraftAnswer) => void;
  disabled: boolean;
  /** For a helper tool_call: the matching result entry (looked up ahead). */
  helperResult?: TranscriptEntry;
  /** For a local helper's result: the stats of that run, recorded just before it. */
  helperStats?: HelperRunStats | null;
  /** For an assistant message: true when helpers ran during this turn. */
  usedHelpers?: boolean;
  /** For a regular tool_call: its paired tool_result (absorbed into this bubble). */
  toolResult?: TranscriptEntry;
}

// Memoized so typing in the composer, or one more streamed event, only
// renders what changed rather than re-parsing every message's markdown.
const ChatEntry = React.memo(function ChatEntry({
  entry,
  agent,
  questionIndex,
  questionPending,
  answer,
  onAnswer,
  disabled,
  helperResult,
  helperStats,
  usedHelpers,
  toolResult,
}: ChatEntryProps) {
  if (entry.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-primary text-primary-foreground px-3.5 py-2 text-sm whitespace-pre-wrap break-words">
          {entry.text}
        </div>
      </div>
    );
  }
  if (entry.role === 'assistant') {
    return (
      <div className="flex gap-2 items-start">
        <AgentAvatar agent={agent} size="sm" />
        <div className="flex flex-col gap-1 max-w-[85%] min-w-0">
          <div
            className={`rounded-2xl rounded-tl-sm px-3.5 py-2 text-sm break-words ${
              usedHelpers ? 'bg-success/10 text-foreground ring-1 ring-success/30' : 'bg-muted text-foreground'
            }`}
          >
            <div className="prose prose-sm max-w-none prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-pre:my-2">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.text ?? ''}</ReactMarkdown>
            </div>
          </div>
          {usedHelpers && (
            <span className="text-[10px] text-success/70 font-medium px-1">↑ used local helpers</span>
          )}
        </div>
      </div>
    );
  }
  if (entry.role === 'tool_call' && QUESTION_TOOL_NAMES.has(stripToolPrefix(entry.toolName))) {
    return (
      <QuestionBubble
        entry={entry}
        index={questionIndex}
        answer={answer}
        onChange={(next) => onAnswer(entry.id, next)}
        disabled={disabled}
        readOnly={!questionPending}
      />
    );
  }
  const helper = helperFor(stripToolPrefix(entry.toolName));
  if (helper && entry.role === 'tool_call') {
    return <HelperBubble helper={helper} callEntry={entry} resultEntry={helperResult} stats={helperStats ?? null} />;
  }
  // tool_result for helpers is rendered inside the call's dialog above; skip standalone.
  if (helper && entry.role === 'tool_result') return null;
  if (entry.role === 'tool_call') {
    return <ToolCallBubble entry={entry} result={toolResult} />;
  }
  if (entry.role === 'tool_result') {
    // Standalone (unabsorbed) result — rare, show generic chip
    return <ToolCallBubble entry={entry} />;
  }
  if (entry.role === 'system') {
    return (
      <div
        className={`text-center text-xs px-3 py-1.5 rounded-md ${
          entry.isError ? 'bg-destructive/10 text-destructive border border-destructive/30' : 'text-muted-foreground'
        }`}
      >
        {entry.text}
      </div>
    );
  }
  return null;
});

export function ChatPane({
  entries,
  onSend,
  disabled,
  placeholder,
  streaming,
  runningTool,
  agent,
  emptyHint,
  readOnly,
  readOnlyNote,
  headerActions,
  className,
}: ChatPaneProps) {
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

  const [visibleLimit, setVisibleLimit] = useState(VISIBLE_ENTRIES_STEP);
  // Never hide a question that's waiting for an answer.
  const firstPendingIndex = batchOpen ? entries.indexOf(pendingQuestions[0]) : -1;
  let firstVisible = Math.max(0, entries.length - visibleLimit);
  if (firstPendingIndex >= 0) firstVisible = Math.min(firstVisible, firstPendingIndex);
  const hiddenCount = firstVisible;

  const setAnswer = useCallback(
    (id: string, answer: DraftAnswer) => setAnswers((prev) => ({ ...prev, [id]: answer })),
    []
  );

  useEffect(() => {
    setAnswers((prev) => {
      const next: Record<string, DraftAnswer> = {};
      for (const id of pendingIds) if (prev[id]) next[id] = prev[id];
      return next;
    });
    // pendingKey is a stable summary of pendingIds (a new array every render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingKey]);

  const canSend =
    !readOnly && !disabled && (draft.trim().length > 0 || pendingFiles.length > 0 || (batchOpen && answeredCount > 0));

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
    onSend?.(message, pendingFiles.length ? pendingFiles : undefined);
    setDraft('');
    setPendingFiles([]);
    setAnswers({});
  };

  const handleFilesSelected = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    setAttachError(null);
    try {
      const read = await readAttachments(fileList);
      setPendingFiles((prev) => [...prev, ...read]);
    } catch (err) {
      setAttachError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Card className={`flex flex-col flex-1 min-h-0 ${className ?? ''}`}>
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border flex-shrink-0">
        <AgentAvatar agent={agent} />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-foreground" title={agent.fullName}>
            {agent.name}
          </div>
          <div className="text-xs text-muted-foreground break-words">{agent.title}</div>
        </div>
        {headerActions && <div className="flex items-center gap-2 flex-shrink-0">{headerActions}</div>}
      </div>

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-4 py-4 space-y-3">
        {entries.length === 0 && !streaming && (
          <div className="py-8 text-center text-sm text-muted-foreground">
            {emptyHint ?? 'Say what you want to build.'}
          </div>
        )}
        {hiddenCount > 0 && (
          <div className="text-center">
            <button
              type="button"
              onClick={() => setVisibleLimit((n) => n + VISIBLE_ENTRIES_STEP)}
              className="text-xs text-primary hover:underline"
            >
              Show {Math.min(hiddenCount, VISIBLE_ENTRIES_STEP)} earlier of {hiddenCount.toLocaleString()} hidden
            </button>
          </div>
        )}
        {(() => {
          // Pre-pass: mark assistant entries that followed helper tool calls in
          // their turn (between the previous user/assistant boundary and this one).
          const assistantWithHelpers = new Set<string>();
          let turnHadHelper = false;
          for (const e of entries) {
            if (e.role === 'user') { turnHadHelper = false; continue; }
            if (e.role === 'tool_result' && helperFor(stripToolPrefix(e.toolName ?? ''))) { turnHadHelper = true; }
            if (e.role === 'assistant') {
              if (turnHadHelper) assistantWithHelpers.add(e.id);
              turnHadHelper = false;
            }
          }

          // Pre-pass: pair each regular tool_call with its tool_result so both
          // can be shown in a single chip. By toolCallId when both carry it —
          // parallel calls can finish out of order — else in order per toolName
          // (entries from before the id was stored).
          const callToResult = new Map<string, TranscriptEntry>(); // call.id → result entry
          const absorbedResultIds = new Set<string>();
          {
            const resultsById = new Map<string, TranscriptEntry>();
            const resultQueues = new Map<string, TranscriptEntry[]>();
            for (const e of entries) {
              if (e.role === 'tool_result' && !helperFor(stripToolPrefix(e.toolName ?? ''))) {
                if (e.toolCallId) {
                  resultsById.set(e.toolCallId, e);
                  continue;
                }
                const n = stripToolPrefix(e.toolName ?? '');
                const q = resultQueues.get(n) ?? [];
                q.push(e);
                resultQueues.set(n, q);
              }
            }
            for (const e of entries) {
              if (
                e.role === 'tool_call' &&
                !QUESTION_TOOL_NAMES.has(stripToolPrefix(e.toolName ?? '')) &&
                !helperFor(stripToolPrefix(e.toolName ?? ''))
              ) {
                const n = stripToolPrefix(e.toolName ?? '');
                const q = resultQueues.get(n);
                const r = e.toolCallId ? resultsById.get(e.toolCallId) : q?.shift();
                if (r) {
                  callToResult.set(e.id, r);
                  absorbedResultIds.add(r.id);
                }
              }
            }
          }

          return entries.slice(firstVisible).map((entry, offset) => {
            const i = firstVisible + offset;
            if (duplicatePendingIds.has(entry.id)) return null;
            // A local helper run's stats show inside its result card.
            if (entry.helper) return null;
            // Tool_results absorbed into their call's chip.
            if (absorbedResultIds.has(entry.id)) return null;

            const helperName = helperFor(stripToolPrefix(entry.toolName));

            // Helper tool_results are rendered inside their call's dialog; skip standalone.
            if (helperName && entry.role === 'tool_result') return null;

            // For a helper call, look ahead for the matching result and stats.
            let helperResult: TranscriptEntry | undefined;
            let helperStats: HelperRunStats | null | undefined;
            if (helperName && entry.role === 'tool_call') {
              for (let j = i + 1; j < entries.length; j++) {
                const e = entries[j];
                if (
                  e.role === 'tool_result' &&
                  helperFor(stripToolPrefix(e.toolName)) === helperName &&
                  (!entry.toolCallId || !e.toolCallId || e.toolCallId === entry.toolCallId)
                ) {
                  helperResult = e;
                  helperStats = helperStatsBefore(entries, j, helperName, (x) => stripToolPrefix(x.toolName));
                  break;
                }
                // Stop at next user/assistant boundary
                if (e.role === 'user' || e.role === 'assistant') break;
              }
            }

            if (entry.role === 'tool_result') {
              // A question tool's result is a trivial placeholder — the
              // question bubble from the preceding tool_call already shows it.
              const prev = entries[i - 1];
              if (prev?.role === 'tool_call' && QUESTION_TOOL_NAMES.has(stripToolPrefix(prev.toolName))) return null;
            }
            const questionIndex = pendingIds.indexOf(entry.id);
            return (
              <ChatEntry
                key={entry.id}
                entry={entry}
                agent={agent}
                questionIndex={questionIndex}
                questionPending={batchOpen && questionIndex >= 0}
                answer={answers[entry.id]}
                onAnswer={setAnswer}
                disabled={disabled}
                helperResult={helperResult}
                helperStats={helperStats}
                usedHelpers={entry.role === 'assistant' ? assistantWithHelpers.has(entry.id) : undefined}
                toolResult={entry.role === 'tool_call' ? callToResult.get(entry.id) : undefined}
              />
            );
          });
        })()}
        {streaming && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span className="w-2 h-2 rounded-full bg-primary animate-pulse" />
            {runningTool
              ? helperFor(stripToolPrefix(runningTool))
                ? `${agent.name} is waiting on a local helper…`
                : `${agent.name} is running ${stripToolPrefix(runningTool)}…`
              : `${agent.name} is thinking…`}
          </div>
        )}
      </div>

      {readOnly ? (
        readOnlyNote && (
          <div className="flex-shrink-0 border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
            {readOnlyNote}
          </div>
        )
      ) : (
        <div className="flex-shrink-0 border-t border-border p-3 space-y-2">
          {batchOpen && (
            <div className="flex items-center gap-3 rounded-md bg-primary/10 border border-primary/20 px-3 py-2">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-foreground">
                  {answeredCount} of {pendingQuestions.length} question
                  {pendingQuestions.length === 1 ? '' : 's'} answered
                </div>
                <div className="text-xs text-muted-foreground">
                  {answeredCount < pendingQuestions.length
                    ? `Answer what you can — anything left blank is sent as "use your best judgment".`
                    : 'All answered — add a note below if you like, then send.'}
                </div>
              </div>
              <div className="h-1.5 w-24 rounded-full bg-primary/20 overflow-hidden flex-shrink-0">
                <div
                  className="h-full bg-primary transition-all"
                  style={{
                    width: `${(answeredCount / pendingQuestions.length) * 100}%`,
                  }}
                />
              </div>
            </div>
          )}
          {attachError && <div className="text-xs text-destructive">{attachError}</div>}
          {pendingFiles.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {pendingFiles.map((f) => (
                <span
                  key={f.name}
                  className="inline-flex items-center gap-1 rounded-full border border-border bg-muted pl-2 pr-1 py-0.5 text-xs text-foreground"
                >
                  <Paperclip className="w-3 h-3" />
                  {f.name}
                  <button
                    type="button"
                    onClick={() => setPendingFiles((prev) => prev.filter((p) => p.name !== f.name))}
                    disabled={disabled}
                    aria-label={`Remove ${f.name}`}
                    className="p-0.5 rounded-full hover:bg-accent"
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
              title="Attach a PDF or text file — it stays available to every agent in this session"
              onClick={() => fileInputRef.current?.click()}
              disabled={disabled}
            >
              <Paperclip />
            </Button>
            <Textarea
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
                  : (placeholder ?? 'Type a message…')
              }
              disabled={disabled}
              rows={2}
              className="flex-1 min-h-0 shadow-sm resize-none disabled:bg-muted"
            />
            <Button onClick={send} disabled={!canSend}>
              <Send />
              {batchOpen && answeredCount > 0 ? `Send answer${answeredCount === 1 ? '' : 's'}` : 'Send'}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
