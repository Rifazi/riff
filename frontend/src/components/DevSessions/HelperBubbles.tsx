'use client';

import { Tags, Users } from 'lucide-react';
import type { HelperName, HelperRunStats, TranscriptEntry } from '@/lib/dev-sessions/types';

// Chat cards for the agents' local helpers (harness-server agents/helpers/):
// work done on this machine instead of in the paid agent's context. Each
// helper's tool call gets a card for what was asked and one for what came
// back, with that run's stats (a system entry recorded just before the
// result) folded into the result card.

/** Tool name → helper. */
export const HELPER_TOOLS: Record<string, HelperName> = {
  delegate: 'research',
  classify_text: 'classifier',
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

function HelperCard({ isError, children }: { isError?: boolean; children: React.ReactNode }) {
  return (
    <div
      className={`rounded-md border text-xs px-2.5 py-2 ${
        isError ? 'border-destructive/30 bg-destructive/10 text-destructive' : 'border-success/40 bg-success/10'
      }`}
    >
      {children}
    </div>
  );
}

function CardTitle({ icon: Icon, children }: { icon: typeof Users; children: React.ReactNode }) {
  return (
    <span className="flex items-center gap-1.5 font-medium text-foreground">
      <Icon className="w-3.5 h-3.5 flex-shrink-0" />
      {children}
    </span>
  );
}

// --- research (`delegate`) ---------------------------------------------------

function ResearchCall({ entry }: { entry: TranscriptEntry }) {
  const input = entry.toolInput as { tasks?: { task?: string; paths?: string[] }[] } | undefined;
  const tasks = input?.tasks ?? [];
  return (
    <HelperCard>
      <CardTitle icon={Users}>
        Asked local helpers {tasks.length} {tasks.length === 1 ? 'question' : 'questions'}
      </CardTitle>
      <ol className="mt-1.5 ml-5 list-decimal space-y-0.5 text-muted-foreground">
        {tasks.map((t, i) => (
          <li key={i} className="break-words">
            {t.task}
            {t.paths?.length ? <span className="font-mono"> — {t.paths.join(', ')}</span> : null}
          </li>
        ))}
      </ol>
    </HelperCard>
  );
}

/** What the helpers handed back (all the paid agent saw), with the run's stats. */
function ResearchResult({ entry, stats }: { entry: TranscriptEntry; stats: HelperRunStats | null }) {
  return (
    <HelperCard isError={entry.isError}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <CardTitle icon={Users}>
          Local helpers answered{stats ? ` ${stats.useful} of ${stats.tasks}` : ''}
        </CardTitle>
        {stats && (
          <span className="text-muted-foreground">
            {stats.model} · read ≈{approxTokens(stats.readChars ?? 0)} tokens on this machine · handed back ≈
            {approxTokens(stats.returnedChars ?? 0)} ·{' '}
            <span className="font-medium text-foreground">
              saved ≈{approxTokens((stats.savedTokens ?? 0) * 4)} paid tokens
            </span>
          </span>
        )}
      </div>
      <div className="mt-1.5 font-mono whitespace-pre-wrap break-words text-foreground/80">
        {toolResultText(entry.toolResult)}
      </div>
    </HelperCard>
  );
}

// --- classifier (`classify_text`) ----------------------------------------------

function ClassifierCall({ entry }: { entry: TranscriptEntry }) {
  const input = entry.toolInput as { text?: string; labels?: string[]; mode?: string } | undefined;
  const labels = input?.labels ?? [];
  return (
    <HelperCard>
      <CardTitle icon={Tags}>
        Asked the on-device classifier to pick {input?.mode === 'multi' ? 'any' : 'one'} of {labels.length} labels
      </CardTitle>
      <div className="mt-1 text-muted-foreground break-words">{labels.join(' · ')}</div>
      {input?.text && (
        <div className="mt-1 text-muted-foreground/80 italic line-clamp-2 break-words">“{input.text}”</div>
      )}
    </HelperCard>
  );
}

function ClassifierResult({ entry, stats }: { entry: TranscriptEntry; stats: HelperRunStats | null }) {
  const value = toolResultValue(entry.toolResult) as {
    model?: string;
    selected?: { label: string; score: number }[];
    allScores?: { label: string; score: number }[];
  } | null;
  if (entry.isError || !value?.allScores) {
    return (
      <HelperCard isError>
        <CardTitle icon={Tags}>Classifier failed</CardTitle>
        <div className="mt-1 break-words">{toolResultText(entry.toolResult)}</div>
      </HelperCard>
    );
  }
  const picked = new Set((value.selected ?? []).map((s) => s.label));
  return (
    <HelperCard>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <CardTitle icon={Tags}>
          Classifier picked {picked.size ? [...picked].join(', ') : 'nothing'}
        </CardTitle>
        <span className="text-muted-foreground">{stats?.model ?? value.model} · on this machine, free</span>
      </div>
      <div className="mt-1.5 space-y-1">
        {value.allScores.map((s) => (
          <div key={s.label} className="flex items-center gap-2">
            <span className={`w-32 truncate ${picked.has(s.label) ? 'font-medium text-foreground' : 'text-muted-foreground'}`}>
              {s.label}
            </span>
            <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
              <div
                className={`h-full rounded-full ${picked.has(s.label) ? 'bg-success' : 'bg-muted-foreground/50'}`}
                style={{ width: `${Math.round(s.score * 100)}%` }}
              />
            </div>
            <span className="w-10 text-right tabular-nums text-muted-foreground">{s.score.toFixed(2)}</span>
          </div>
        ))}
      </div>
    </HelperCard>
  );
}

export function HelperCallBubble({ helper, entry }: { helper: HelperName; entry: TranscriptEntry }) {
  return helper === 'research' ? <ResearchCall entry={entry} /> : <ClassifierCall entry={entry} />;
}

export function HelperResultBubble({
  helper,
  entry,
  stats,
}: {
  helper: HelperName;
  entry: TranscriptEntry;
  stats: HelperRunStats | null;
}) {
  return helper === 'research' ? (
    <ResearchResult entry={entry} stats={stats} />
  ) : (
    <ClassifierResult entry={entry} stats={stats} />
  );
}
