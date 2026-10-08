'use client';

import { ChevronRight, Tags, Terminal, Users } from 'lucide-react';
import { useState } from 'react';
import type { HelperName, HelperRunStats, TranscriptEntry } from '@/lib/dev-sessions/types';

// Blue dialog cards for the agents' local helpers (harness-server agents/helpers/):
// each helper invocation (call + result) appears as one combined blue dialog.

/** Tool name → helper. */
export const HELPER_TOOLS: Record<string, HelperName> = {
  delegate: 'research',
  classify_text: 'classifier',
  run_checked_command: 'runner',
};

export function helperFor(toolName: string): HelperName | null {
  return HELPER_TOOLS[toolName] ?? null;
}

/** A helper result's stats: recorded after its call, just before the result. */
export function helperStatsBefore(
  entries: TranscriptEntry[],
  resultIndex: number,
  helper: HelperName,
  toolNameOf: (e: TranscriptEntry) => string,
): HelperRunStats | null {
  for (let j = resultIndex - 1; j >= 0; j--) {
    const e = entries[j];
    if (e.helper?.helper === helper) return e.helper;
    if (e.role === 'tool_call' && helperFor(toolNameOf(e)) === helper) return null;
  }
  return null;
}

/** A tool result as plain text: the AI-SDK engine stores the value, the Claude engine MCP content blocks. */
function toolResultText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (Array.isArray(result)) {
    return result
      .map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : ''))
      .join('\n');
  }
  return JSON.stringify(result ?? '');
}

function toolResultValue(result: unknown): unknown {
  if (result && typeof result === 'object' && !Array.isArray(result)) return result;
  try {
    return JSON.parse(toolResultText(result));
  } catch {
    return null;
  }
}

const approxTokens = (chars: number) => {
  const t = Math.round(chars / 4);
  return t >= 1000 ? `${(t / 1000).toFixed(t >= 10_000 ? 0 : 1)}k` : String(t);
};

// Shared dialog shell for helper calls + results (research and classifier).
function HelperDialog({
  icon: Icon,
  label,
  badge,
  isError,
  startOpen,
  children,
}: {
  icon: typeof Users;
  label: string;
  badge?: string;
  isError?: boolean;
  startOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(() => startOpen ?? false);
  return (
    <details
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
      className={`group rounded-md border text-xs font-mono ${
        isError
          ? 'border-destructive/30 bg-destructive/10 text-destructive'
          : 'border-info/25 bg-info/5 text-info'
      }`}
    >
      <summary className="flex items-center gap-1.5 px-2.5 py-1.5 cursor-pointer select-none list-none">
        <ChevronRight className="w-3 h-3 transition-transform group-open:rotate-90 flex-shrink-0 opacity-50" />
        <Icon className="w-3 h-3 flex-shrink-0 opacity-70" />
        <span className="font-medium">{label}</span>
        {badge && <span className="ml-auto pl-2 flex-shrink-0 font-mono opacity-50 text-[10px]">{badge}</span>}
      </summary>
      {open && <div className="px-3 pb-2.5 pt-1 font-sans text-foreground">{children}</div>}
    </details>
  );
}

// --- research (`delegate`) ---------------------------------------------------

function ResearchDialog({
  callEntry,
  resultEntry,
  stats,
}: {
  callEntry: TranscriptEntry;
  resultEntry?: TranscriptEntry;
  stats: HelperRunStats | null;
}) {
  const input = callEntry.toolInput as { tasks?: { task?: string; paths?: string[] }[] } | undefined;
  const tasks = input?.tasks ?? [];
  const savedBadge = stats?.savedTokens ? ` · saved ≈${approxTokens((stats.savedTokens ?? 0) * 4)}` : '';
  const isError = resultEntry?.isError ?? false;
  return (
    <HelperDialog
      icon={Users}
      label={`Research helper — ${tasks.length} ${tasks.length === 1 ? 'question' : 'questions'}`}
      badge={stats ? `${stats.useful}/${stats.tasks} answered${stats.model ? ` · ${stats.model}` : ''}${savedBadge}` : undefined}
      isError={isError}
      startOpen={callEntry.id.startsWith('overlay-')}
    >
      <div className="space-y-2 text-xs">
        <ol className="ml-4 list-decimal space-y-1 text-muted-foreground break-words">
          {tasks.map((t, i) => (
            <li key={i}>
              <span>{t.task}</span>
              {t.paths?.length ? (
                <span className="font-mono opacity-50 ml-1">— {t.paths.join(', ')}</span>
              ) : null}
            </li>
          ))}
        </ol>
        {resultEntry && (
          <div className="border-t border-info/20 pt-2 whitespace-pre-wrap break-all text-muted-foreground font-mono">
            {toolResultText(resultEntry.toolResult)}
          </div>
        )}
      </div>
    </HelperDialog>
  );
}

// --- classifier (`classify_text`) --------------------------------------------

function ClassifierDialog({
  callEntry,
  resultEntry,
  stats,
}: {
  callEntry: TranscriptEntry;
  resultEntry?: TranscriptEntry;
  stats: HelperRunStats | null;
}) {
  const input = callEntry.toolInput as { text?: string; labels?: string[]; mode?: string } | undefined;
  const labels = input?.labels ?? [];
  const isError = resultEntry?.isError ?? false;

  const value =
    resultEntry && !isError
      ? (toolResultValue(resultEntry.toolResult) as {
          model?: string;
          selected?: { label: string; score: number }[];
          allScores?: { label: string; score: number }[];
        } | null)
      : null;

  const picked = new Set((value?.selected ?? []).map((s) => s.label));
  const pickedList = picked.size ? [...picked].join(', ') : undefined;
  const model = stats?.model ?? value?.model;

  return (
    <HelperDialog
      icon={Tags}
      label={`Classifier — ${input?.mode === 'multi' ? 'any' : 'one'} of ${labels.length} labels`}
      badge={pickedList ? `${pickedList}${model ? ` · ${model}` : ''}` : model ?? undefined}
      isError={isError}
      startOpen={callEntry.id.startsWith('overlay-')}
    >
      <div className="space-y-2 text-xs">
        <div className="text-muted-foreground space-y-0.5">
          <div className="break-words opacity-70">{labels.join(' · ')}</div>
          {input?.text && (
            <div className="opacity-50 italic line-clamp-2 break-words">"{input.text}"</div>
          )}
        </div>
        {resultEntry && isError && (
          <div className="border-t border-destructive/20 pt-2 break-words text-muted-foreground font-mono">
            {toolResultText(resultEntry.toolResult)}
          </div>
        )}
        {value?.allScores && (
          <div className="border-t border-info/20 pt-2 space-y-1.5">
            {value.allScores.map((s) => (
              <div key={s.label} className="flex items-center gap-2">
                <span className={`w-28 truncate ${picked.has(s.label) ? 'font-medium text-foreground' : 'text-muted-foreground opacity-60'}`}>
                  {s.label}
                </span>
                <div className="flex-1 h-1 rounded-full bg-info/15 overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${picked.has(s.label) ? 'bg-info' : 'bg-info/25'}`}
                    style={{ width: `${Math.round(s.score * 100)}%` }}
                  />
                </div>
                <span className="w-8 text-right tabular-nums text-muted-foreground opacity-50">{s.score.toFixed(2)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </HelperDialog>
  );
}

// --- runner (`run_checked_command`) ------------------------------------------

function RunnerDialog({
  callEntry,
  resultEntry,
  stats,
}: {
  callEntry: TranscriptEntry;
  resultEntry?: TranscriptEntry;
  stats: HelperRunStats | null;
}) {
  const input = callEntry.toolInput as { command?: string } | undefined;
  const command = input?.command ?? 'check';
  const isError = resultEntry?.isError ?? false;
  const result = resultEntry ? toolResultText(resultEntry.toolResult) : '';
  const passed = result.toLowerCase().includes('passed') || result.toLowerCase().includes('succeeded');
  const savedBadge = stats?.savedTokens ? ` · saved ≈${approxTokens((stats.savedTokens ?? 0) * 4)}` : '';
  return (
    <HelperDialog
      icon={Terminal}
      label={`Runner — ${command}`}
      badge={stats ? `${passed ? 'passed' : 'failed'}${stats.model ? ` · ${stats.model}` : ''}${savedBadge}` : (passed ? 'passed' : 'failed')}
      isError={isError || (!passed && !!result)}
      startOpen={callEntry.id.startsWith('overlay-') || !passed}
    >
      <div className="whitespace-pre-wrap break-all text-xs text-muted-foreground font-mono">{result}</div>
    </HelperDialog>
  );
}

// ChatPane renders HelperBubble for each tool_call; it passes the matching
// result entry (looked up ahead in the entries array) so both appear in one
// blue dialog instead of two separate cards.
export function HelperBubble({
  helper,
  callEntry,
  resultEntry,
  stats,
}: {
  helper: HelperName;
  callEntry: TranscriptEntry;
  resultEntry?: TranscriptEntry;
  stats: HelperRunStats | null;
}) {
  if (helper === 'research') return <ResearchDialog callEntry={callEntry} resultEntry={resultEntry} stats={stats} />;
  if (helper === 'runner') return <RunnerDialog callEntry={callEntry} resultEntry={resultEntry} stats={stats} />;
  return <ClassifierDialog callEntry={callEntry} resultEntry={resultEntry} stats={stats} />;
}
