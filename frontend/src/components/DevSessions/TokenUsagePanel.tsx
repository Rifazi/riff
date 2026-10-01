'use client';

import { useState } from 'react';
import Link from 'next/link';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '@/lib/dev-sessions/api';
import { sessionHref } from '@/lib/dev-sessions/stage';
import type { TokenUsage, UsageRange, UsageReport, UsageStage } from '@/lib/dev-sessions/types';
import { LoadingState } from './PageShell';

// Categorical slots 1-4 of the validated reference palette, in pipeline
// order (adjacent pairs pass CVD separation). Coding (aqua) and QA (yellow)
// are under 3:1 on white, so the chart always has a legend and a table view.
const STAGES: { key: UsageStage; label: string; color: string }[] = [
  { key: 'requirements', label: 'Requirements', color: '#2a78d6' },
  { key: 'plan', label: 'Plan', color: '#eb6834' },
  { key: 'coding', label: 'Coding', color: '#1baf7a' },
  { key: 'qa', label: 'QA', color: '#eda100' },
];

const RANGES: UsageRange[] = [7, 30, 90];

const TOKEN_TYPES: { key: keyof TokenUsage; label: string; hint: string }[] = [
  { key: 'cacheRead', label: 'Cache reads', hint: 'The conversation so far, re-sent on every tool step' },
  { key: 'cacheWrite', label: 'Cache writes', hint: 'New context stored for the next step to re-read' },
  { key: 'output', label: 'Output', hint: 'What the agents wrote: code, docs, tool calls' },
  { key: 'input', label: 'Uncached input', hint: 'Prompt text sent without the cache' },
];

const sum = (u: TokenUsage) => u.input + u.output + u.cacheRead + u.cacheWrite;
const stageSum = (byStage: Record<UsageStage, number>) => STAGES.reduce((acc, s) => acc + byStage[s.key], 0);

function compact(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 10_000_000) return `${Math.round(n / 1_000_000)}M`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

const full = (n: number) => n.toLocaleString();
const percent = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : '—');

/** "2026-10-01" as a local date — not UTC midnight, which can land on the day before. */
function parseDay(date: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d);
}

const dayLabel = (date: string, opts: Intl.DateTimeFormatOptions) => parseDay(date).toLocaleDateString(undefined, opts);

/** 3-5 round gridline values (a 1, 2 or 5 step) from 0 to at least `max`. */
function niceTicks(max: number): number[] {
  if (max <= 0) return [0, 1];
  const rough = max / 4;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((v) => v >= rough) ?? 10 * pow;
  const top = Math.ceil(max / step) * step;
  return Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
}

function StatTile({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-lg border border-gray-200 p-4">
      <div className="text-xs font-medium text-gray-500">{label}</div>
      <div className="text-2xl font-semibold text-gray-900 mt-1 tabular-nums">{value}</div>
      <div className="text-xs text-gray-500 mt-1">{detail}</div>
    </div>
  );
}

function DailyChart({ daily }: { daily: UsageReport['daily'] }) {
  const [hover, setHover] = useState<number | null>(null);
  const totals = daily.map((d) => stageSum(d.byStage));
  const ticks = niceTicks(Math.max(...totals));
  const yMax = ticks[ticks.length - 1];
  const labelEvery = daily.length <= 7 ? 1 : daily.length <= 30 ? 5 : 15;
  const gap = daily.length <= 7 ? 'gap-3' : daily.length <= 30 ? 'gap-1' : 'gap-px';
  const hovered = hover === null ? null : daily[hover];

  return (
    <div className="relative pt-3" onPointerLeave={() => setHover(null)}>
      <div className="flex">
        {/* y axis */}
        <div className="relative w-12 h-52 flex-shrink-0">
          {ticks.map((t) => (
            <div
              key={t}
              className="absolute right-2 text-[11px] text-gray-500 tabular-nums -translate-y-1/2"
              style={{ bottom: `${(t / yMax) * 100}%` }}
            >
              {compact(t)}
            </div>
          ))}
        </div>
        <div className="relative flex-1 h-52">
          {ticks.map((t) => (
            <div
              key={t}
              className={`absolute inset-x-0 border-t ${t === 0 ? 'border-gray-300' : 'border-gray-100'}`}
              style={{ bottom: `${(t / yMax) * 100}%` }}
            />
          ))}
          <div className={`absolute inset-0 flex items-end ${gap}`}>
            {daily.map((d, i) => {
              const total = totals[i];
              const segments = [...STAGES].reverse().filter((s) => total > 0 && d.byStage[s.key] / total >= 0.004);
              return (
                <button
                  key={d.date}
                  type="button"
                  className="relative flex-1 h-full flex items-end focus:outline-none group"
                  onPointerEnter={() => setHover(i)}
                  onFocus={() => setHover(i)}
                  onBlur={() => setHover(null)}
                  aria-label={`${dayLabel(d.date, { month: 'short', day: 'numeric' })}: ${full(total)} tokens`}
                >
                  {total > 0 && (
                    <div
                      className={`w-full flex flex-col gap-[2px] rounded-t overflow-hidden transition-opacity ${
                        hover !== null && hover !== i ? 'opacity-50' : ''
                      } group-focus-visible:ring-2 group-focus-visible:ring-gray-400`}
                      style={{ height: `${Math.max((total / yMax) * 100, 0.8)}%` }}
                    >
                      {segments.map((s) => (
                        <div key={s.key} style={{ flex: `${d.byStage[s.key]} 1 0`, background: s.color, minHeight: 1 }} />
                      ))}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* x axis */}
      <div className="flex mt-1.5">
        <div className="w-12 flex-shrink-0" />
        <div className={`flex-1 flex ${gap}`}>
          {daily.map((d, i) => (
            <div key={d.date} className="flex-1 relative h-4">
              {(i % labelEvery === 0 || i === daily.length - 1) && (
                <span className="absolute left-1/2 -translate-x-1/2 text-[11px] text-gray-500 whitespace-nowrap">
                  {dayLabel(d.date, daily.length <= 7 ? { weekday: 'short' } : { month: 'short', day: 'numeric' })}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>

      {hovered && hover !== null && (
        <div
          className="absolute top-0 z-10 pointer-events-none rounded-md border border-gray-200 bg-white shadow-lg px-3 py-2 text-xs w-52"
          style={{
            left: `calc(3rem + (100% - 3rem) * ${(hover + 0.5) / daily.length})`,
            transform: `translateX(${hover / daily.length > 0.6 ? '-105%' : '5%'})`,
          }}
        >
          <div className="text-gray-500">{dayLabel(hovered.date, { weekday: 'short', month: 'short', day: 'numeric' })}</div>
          <div className="text-sm font-semibold text-gray-900 tabular-nums mb-1.5">{full(totals[hover])} tokens</div>
          {[...STAGES].reverse().map((s) => (
            <div key={s.key} className="flex items-center gap-2 py-0.5">
              <span className="w-3 h-0.5 rounded-full" style={{ background: s.color }} />
              <span className="font-semibold text-gray-900 tabular-nums">{compact(hovered.byStage[s.key])}</span>
              <span className="text-gray-500">{s.label}</span>
            </div>
          ))}
          {hovered.estimated > 0 && (
            <div className="text-gray-500 mt-1.5 pt-1.5 border-t border-gray-100">
              {hovered.estimated === totals[hover] ? 'All' : `${compact(hovered.estimated)}`} estimated — from before
              per-turn tracking.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DailyTable({ daily }: { daily: UsageReport['daily'] }) {
  const rows = daily.filter((d) => stageSum(d.byStage) > 0).reverse();
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-gray-500 border-b border-gray-200">
            <th className="py-2 pr-4 font-medium">Day</th>
            {STAGES.map((s) => (
              <th key={s.key} className="py-2 px-3 font-medium text-right">
                {s.label}
              </th>
            ))}
            <th className="py-2 pl-3 font-medium text-right">Total</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map((d) => (
            <tr key={d.date} className="tabular-nums">
              <td className="py-1.5 pr-4 text-gray-700">
                {dayLabel(d.date, { weekday: 'short', month: 'short', day: 'numeric' })}
                {d.estimated > 0 && <span className="text-gray-400"> · est.</span>}
              </td>
              {STAGES.map((s) => (
                <td key={s.key} className="py-1.5 px-3 text-right text-gray-700">
                  {full(d.byStage[s.key])}
                </td>
              ))}
              <td className="py-1.5 pl-3 text-right font-medium text-gray-900">{full(stageSum(d.byStage))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex rounded-md border border-gray-200 p-0.5 bg-gray-50">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
          className={`px-2.5 py-1 text-xs font-medium rounded ${
            o.value === value ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600 hover:text-gray-900'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function TokenUsagePanel() {
  const [days, setDays] = useState<UsageRange>(30);
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: ['usage', days],
    queryFn: () => api.getUsage(days),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });

  const total = data ? sum(data.totals.usage) : 0;
  const topStage = data ? [...STAGES].sort((a, b) => sum(data.totals.byStage[b.key]) - sum(data.totals.byStage[a.key]))[0] : null;
  const topSessions = data?.sessions.slice(0, 8) ?? [];
  const sessionMax = topSessions.length ? sum(topSessions[0].usage) : 0;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6 shadow-sm">
      <h3 className="text-lg font-semibold text-gray-900">Token usage</h3>
      <p className="text-sm text-gray-600 mt-1 mb-4">
        Tokens the requirements, plan, coding and QA agents used on the provider you configured. Riff&apos;s built-in
        local model runs on this machine and isn&apos;t counted.
      </p>

      <div className="flex flex-wrap items-center gap-2 mb-5">
        <Segmented
          label="Date range"
          value={days}
          onChange={setDays}
          options={RANGES.map((r) => ({ value: r, label: `Last ${r} days` }))}
        />
        <div className="flex-1" />
        <Segmented
          label="View"
          value={view}
          onChange={setView}
          options={[
            { value: 'chart', label: 'Chart' },
            { value: 'table', label: 'Table' },
          ]}
        />
      </div>

      {isLoading ? (
        <LoadingState />
      ) : error || !data ? (
        <div className="py-6 text-sm text-red-600">
          Couldn&apos;t load usage{error instanceof Error ? `: ${error.message}` : ''}. Is the agent server running?
        </div>
      ) : total === 0 ? (
        <div className="py-10 text-center text-sm text-gray-500 border border-dashed border-gray-300 rounded-lg">
          No agent usage in the last {days} days.
        </div>
      ) : (
        <div className={`space-y-8 transition-opacity ${isFetching ? 'opacity-60' : ''}`}>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <StatTile label="Total tokens" value={compact(total)} detail={`across ${data.totals.sessions} sessions`} />
            <StatTile
              label="Cache reads"
              value={percent(data.totals.usage.cacheRead, total)}
              detail={`${compact(data.totals.usage.cacheRead)} re-sent context`}
            />
            <StatTile label="Output" value={compact(data.totals.usage.output)} detail="written by the agents" />
            {topStage && (
              <StatTile
                label="Biggest stage"
                value={topStage.label}
                detail={`${percent(sum(data.totals.byStage[topStage.key]), total)} of all tokens`}
              />
            )}
          </div>

          <div>
            <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
              <h4 className="text-sm font-semibold text-gray-900">Per day, by stage</h4>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {STAGES.map((s) => (
                  <div key={s.key} className="flex items-center gap-1.5 text-xs">
                    <span className="w-2.5 h-2.5 rounded-sm" style={{ background: s.color }} />
                    <span className="text-gray-600">{s.label}</span>
                    <span className="font-medium text-gray-900 tabular-nums">{compact(sum(data.totals.byStage[s.key]))}</span>
                  </div>
                ))}
              </div>
            </div>
            {view === 'chart' ? <DailyChart daily={data.daily} /> : <DailyTable daily={data.daily} />}
            {data.totals.estimated > 0 && (
              <p className="text-xs text-gray-500 mt-3">
                {percent(data.totals.estimated, total)} of this range is estimated: it&apos;s from before per-turn tracking
                {data.trackedSince
                  ? ` began on ${new Date(data.trackedSince).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
                  : ' began'}
                , so each stage&apos;s total is dated to that stage&apos;s last activity.
              </p>
            )}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
            <div>
              <h4 className="text-sm font-semibold text-gray-900 mb-3">What the tokens were</h4>
              <div className="space-y-3">
                {TOKEN_TYPES.map((t) => {
                  const value = data.totals.usage[t.key];
                  return (
                    <div key={t.key}>
                      <div className="flex items-baseline justify-between text-sm">
                        <span className="text-gray-700">{t.label}</span>
                        <span className="tabular-nums">
                          <span className="font-medium text-gray-900">{compact(value)}</span>
                          <span className="text-gray-500"> · {percent(value, total)}</span>
                        </span>
                      </div>
                      <div className="h-2 mt-1 rounded-full bg-gray-100 overflow-hidden">
                        <div className="h-full rounded-full bg-gray-500" style={{ width: `${total > 0 ? (value / total) * 100 : 0}%` }} />
                      </div>
                      <div className="text-xs text-gray-500 mt-0.5">{t.hint}</div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div>
              <h4 className="text-sm font-semibold text-gray-900 mb-3">Top sessions</h4>
              <div className="space-y-3">
                {topSessions.map((s) => {
                  const sessionTotal = sum(s.usage);
                  return (
                    <div key={s.id}>
                      <div className="flex items-baseline justify-between gap-3 text-sm">
                        <div className="min-w-0 truncate">
                          {s.exists ? (
                            <Link href={sessionHref(s.id)} className="text-gray-900 hover:underline">
                              {s.title}
                            </Link>
                          ) : (
                            <span className="text-gray-500 italic">{s.title}</span>
                          )}
                          {s.appName && <span className="text-xs text-gray-500"> · {s.appName}</span>}
                        </div>
                        <span className="font-medium text-gray-900 tabular-nums flex-shrink-0">{compact(sessionTotal)}</span>
                      </div>
                      <div
                        className="flex gap-[2px] h-2 mt-1 rounded-r overflow-hidden"
                        style={{ width: `${sessionMax > 0 ? Math.max((sessionTotal / sessionMax) * 100, 1) : 0}%` }}
                      >
                        {STAGES.filter((st) => sessionTotal > 0 && s.byStage[st.key] / sessionTotal >= 0.004).map((st) => (
                          <div
                            key={st.key}
                            title={`${st.label}: ${full(s.byStage[st.key])} tokens`}
                            style={{ flex: `${s.byStage[st.key]} 1 0`, background: st.color }}
                          />
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {data.toolOutput && data.toolOutput.length > 0 && <ToolOutput rows={data.toolOutput} />}
        </div>
      )}
    </div>
  );
}

// Tool results stay in the conversation and are re-read on every later
// step, so this is what the cache reads above are mostly made of.
function ToolOutput({ rows }: { rows: NonNullable<UsageReport['toolOutput']> }) {
  const totalChars = rows.reduce((acc, r) => acc + r.chars, 0);
  const shown = rows.slice(0, 8);
  return (
    <div>
      <h4 className="text-sm font-semibold text-gray-900">Tool output</h4>
      <p className="text-xs text-gray-500 mt-0.5 mb-3">
        What each tool returned to the agents (about 4 characters per token). Every result is re-read on each later step
        of its conversation, so the biggest rows here are the ones worth trimming.
      </p>
      <div className="space-y-3">
        {shown.map((r) => (
          <div key={r.tool}>
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="font-mono text-xs text-gray-700">{r.tool}</span>
              <span className="tabular-nums">
                <span className="font-medium text-gray-900">≈{compact(Math.round(r.chars / 4))} tokens</span>
                <span className="text-gray-500">
                  {' '}
                  · {percent(r.chars, totalChars)} · {full(r.calls)} {r.calls === 1 ? 'call' : 'calls'} · ≈
                  {compact(Math.round(r.chars / 4 / r.calls))} each
                </span>
              </span>
            </div>
            <div className="h-2 mt-1 rounded-full bg-gray-100 overflow-hidden">
              <div className="h-full rounded-full bg-gray-500" style={{ width: `${totalChars > 0 ? (r.chars / totalChars) * 100 : 0}%` }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
