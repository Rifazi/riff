'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/dev-sessions/api';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { TokenUsagePanel } from './TokenUsagePanel';
import type { UsageStage } from '@/lib/dev-sessions/types';

const R = 12;
const C = 2 * Math.PI * R;

const STAGES: UsageStage[] = ['requirements', 'plan', 'coding', 'qa'];
// Explicit colors — immune to theme overrides on the sidebar background
const COLORS = ['#6366f1', '#22c55e', '#3b82f6', '#f97316'];

const BUDGET_KEY = 'riff:token-budget-monthly';
function readBudget(): number | null {
  try { const v = localStorage.getItem(BUDGET_KEY); return v ? Number(v) : null; } catch { return null; }
}
function writeBudget(n: number | null) {
  try { n == null ? localStorage.removeItem(BUDGET_KEY) : localStorage.setItem(BUDGET_KEY, String(n)); } catch {}
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

interface Props { showLabel?: boolean; }

export function TokenRingIndicator({ showLabel = false }: Props) {
  const [open, setOpen] = useState(false);
  const [budget, setBudgetState] = useState<number | null>(() => {
    if (typeof window === 'undefined') return null;
    return readBudget();
  });
  const [budgetInput, setBudgetInput] = useState('');

  const { data } = useQuery({
    queryKey: ['usage', 30] as const,
    queryFn: () => api.getUsage(30),
    refetchInterval: 5 * 60_000,
    retry: 1,
  });

  if (!data) return null;

  const today = new Date().toISOString().split('T')[0];
  const todayEntry = data.daily.find((d) => d.date === today);
  const byStage = todayEntry?.byStage ?? { requirements: 0, plan: 0, coding: 0, qa: 0 };
  const todayTotal = STAGES.reduce((sum, s) => sum + (byStage[s] ?? 0), 0);

  const m = data.totals.usage;
  const monthTotal = m.input + m.output + m.cacheRead;
  const activeDays = data.daily.filter((d) => STAGES.some((s) => (d.byStage[s] ?? 0) > 0)).length;
  const dailyAvg = activeDays > 0 ? Math.round(monthTotal / activeDays) : 0;

  const budgetPct = budget && budget > 0 ? Math.min(monthTotal / budget, 1) : null;
  const barColor = (pct: number) => pct > 0.85 ? '#ef4444' : pct > 0.6 ? '#f97316' : '#22c55e';

  // SVG arc segments for today's stage breakdown
  let cumLen = 0;
  const arcs = STAGES.map((stage, i) => {
    const tokens = byStage[stage] ?? 0;
    const arcLen = todayTotal > 0 ? (tokens / todayTotal) * C : 0;
    const dashoffset = C * 0.25 - cumLen;
    cumLen += arcLen;
    return { stage, tokens, arcLen, dashoffset, color: COLORS[i] };
  }).filter((a) => a.tokens > 0);

  const ring = (
    <svg width="28" height="28" viewBox="0 0 32 32" fill="none" aria-hidden>
      <circle cx="16" cy="16" r={R} strokeWidth="4" fill="none" stroke="rgba(128,128,128,0.25)" />
      {arcs.map((arc) => (
        <circle key={arc.stage} cx="16" cy="16" r={R}
          strokeWidth="4" fill="none" stroke={arc.color}
          strokeDasharray={`${arc.arcLen} ${C - arc.arcLen}`}
          strokeDashoffset={arc.dashoffset} strokeLinecap="butt"
        />
      ))}
    </svg>
  );

  const handleSaveBudget = () => {
    const n = parseInt(budgetInput.replace(/[^0-9]/g, ''), 10);
    if (!isNaN(n) && n > 0) { writeBudget(n); setBudgetState(n); }
    setBudgetInput('');
  };

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className={`flex items-center rounded-md hover:bg-white/10 transition-colors focus-visible:outline-none ${
          showLabel ? 'gap-2.5 w-full px-2 py-2' : 'w-8 h-8 justify-center mx-auto'
        }`}
        aria-label="Token usage"
      >
        {ring}

        {showLabel && (
          <div className="flex flex-col leading-none text-left min-w-0 flex-1">
            {/* Primary line: today + avg */}
            <div className="flex items-baseline gap-1">
              <span className="text-xs font-semibold text-foreground/90 tabular-nums">
                {todayTotal === 0 ? '—' : fmt(todayTotal)}
              </span>
              <span className="text-[10px] text-muted-foreground">today</span>
              {dailyAvg > 0 && (
                <span className="text-[10px] text-muted-foreground ml-auto">{fmt(dailyAvg)}/day</span>
              )}
            </div>

            {/* Secondary line: budget bar or 30d total */}
            {budgetPct !== null ? (
              <div className="flex items-center gap-1.5 mt-1">
                <div className="flex-1 h-1.5 rounded-full bg-white/15 overflow-hidden">
                  <div className="h-full rounded-full transition-all"
                    style={{ width: `${budgetPct * 100}%`, backgroundColor: barColor(budgetPct) }} />
                </div>
                <span className="text-[10px] text-muted-foreground tabular-nums whitespace-nowrap">
                  {fmt(monthTotal)}/{fmt(budget!)}
                </span>
              </div>
            ) : (
              <span className="text-[10px] text-muted-foreground mt-0.5">
                {monthTotal === 0 ? 'No usage this month' : `${fmt(monthTotal)} this month`}
              </span>
            )}
          </div>
        )}
      </button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="sm:max-w-2xl w-full overflow-y-auto p-6">
          <SheetHeader className="mb-6">
            <SheetTitle>Token Usage</SheetTitle>

            {/* Monthly budget row */}
            <div className="flex items-center gap-2 mt-3">
              <span className="text-sm text-muted-foreground shrink-0">Monthly budget:</span>
              {budget ? (
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
                    <div className="h-full rounded-full transition-all"
                      style={{ width: `${Math.min((monthTotal / budget) * 100, 100)}%`, backgroundColor: barColor(monthTotal / budget) }} />
                  </div>
                  <span className="text-sm tabular-nums text-muted-foreground whitespace-nowrap">
                    {fmt(monthTotal)} / {fmt(budget)}
                  </span>
                  <button className="text-xs text-muted-foreground hover:text-foreground underline shrink-0"
                    onClick={() => { writeBudget(null); setBudgetState(null); }}>
                    clear
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-1.5">
                  <input type="text" inputMode="numeric" placeholder="e.g. 500000"
                    value={budgetInput}
                    onChange={(e) => setBudgetInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleSaveBudget()}
                    className="w-32 h-7 px-2 text-sm border border-input rounded bg-background text-foreground" />
                  <button className="h-7 px-3 text-sm bg-primary text-primary-foreground rounded hover:opacity-90"
                    onClick={handleSaveBudget}>
                    Set
                  </button>
                  <span className="text-xs text-muted-foreground">tokens / month</span>
                </div>
              )}
            </div>
          </SheetHeader>

          <TokenUsagePanel />
        </SheetContent>
      </Sheet>
    </>
  );
}
