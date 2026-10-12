'use client';

import { useState } from 'react';
import { CheckCircle2, ChevronRight, Circle, CircleDot, XCircle } from 'lucide-react';
import { Card } from '@/components/ui/card';
import type { CodingPlanStep } from '@/lib/dev-sessions/types';

/** A checklist row: a plan step, or anything shaped like one (a QA reviewer's criteria, where "failed" = not met). */
export type ChecklistItem = Omit<CodingPlanStep, 'status'> & { status: CodingPlanStep['status'] | 'failed' };

export function CodingPlanChecklist({
  steps,
  title = 'Coding checklist',
  countLabel = (done, total) => `${done} of ${total} step${total === 1 ? '' : 's'} done`,
}: {
  steps: ChecklistItem[];
  title?: string;
  countLabel?: (done: number, total: number) => string;
}) {
  const doneCount = steps.filter((s) => s.status === 'done').length;
  // Collapsing hides only the step list: the title, count and progress bar stay visible.
  const [open, setOpen] = useState(true);

  return (
    <Card className="p-3">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 mb-2 text-left"
      >
        <div className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
          <ChevronRight
            className={`w-3.5 h-3.5 flex-shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-90' : ''}`}
          />
          {title}
        </div>
        <div className="text-xs text-muted-foreground">{countLabel(doneCount, steps.length)}</div>
      </button>
      <div className={`h-1.5 rounded-full bg-muted overflow-hidden ${open ? 'mb-3' : ''}`}>
        <div
          className="h-full bg-success transition-all"
          style={{ width: `${steps.length ? (doneCount / steps.length) * 100 : 0}%` }}
        />
      </div>
      {open && (
        <ul className="space-y-1.5 max-h-40 overflow-y-auto custom-scrollbar">
          {steps.map((step) => (
            <li
              key={step.id}
              className={`flex items-start gap-2 text-sm ${
                step.status === 'done'
                  ? 'text-muted-foreground'
                  : step.status === 'in_progress'
                    ? 'text-primary font-medium'
                    : step.status === 'failed'
                      ? 'text-destructive'
                      : 'text-foreground'
              }`}
            >
              {step.status === 'done' ? (
                <CheckCircle2 className="w-4 h-4 mt-0.5 text-success flex-shrink-0" />
              ) : step.status === 'failed' ? (
                <XCircle className="w-4 h-4 mt-0.5 text-destructive flex-shrink-0" />
              ) : step.status === 'in_progress' ? (
                <CircleDot className="w-4 h-4 mt-0.5 text-primary flex-shrink-0" />
              ) : (
                <Circle className="w-4 h-4 mt-0.5 text-muted-foreground/50 flex-shrink-0" />
              )}
              <span title={step.brief}>{step.title}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
