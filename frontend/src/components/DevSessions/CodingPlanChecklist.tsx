import React from 'react';
import { CheckCircle2, Circle, CircleDot, XCircle } from 'lucide-react';
import type { CodingPlanStep } from '@/lib/dev-sessions/types';
import { CollapsibleSection } from './CollapsibleSection';

/** A checklist row: a plan step, or anything shaped like one (a QA reviewer's criteria, where "failed" = not met). */
export type ChecklistItem = Omit<CodingPlanStep, 'status'> & { status: CodingPlanStep['status'] | 'failed' };

function StepIcon({ status }: { status: ChecklistItem['status'] }) {
  if (status === 'done') return <CheckCircle2 className="w-4 h-4 mt-0.5 text-success flex-shrink-0" />;
  if (status === 'failed') return <XCircle className="w-4 h-4 mt-0.5 text-destructive flex-shrink-0" />;
  if (status === 'in_progress') return <CircleDot className="w-4 h-4 mt-0.5 text-primary flex-shrink-0" />;
  return <Circle className="w-4 h-4 mt-0.5 text-muted-foreground/50 flex-shrink-0" />;
}

/**
 * Collapsed to its progress bar and the step being worked on (or the first
 * unmet / next one); opens to the full list plus any `children`.
 */
export function CodingPlanChecklist({
  steps,
  title = 'Coding checklist',
  countLabel = (done, total) => `${done} of ${total} step${total === 1 ? '' : 's'} done`,
  actions,
  children,
}: {
  steps: ChecklistItem[];
  title?: string;
  countLabel?: (done: number, total: number) => string;
  /** Beside the header, e.g. Continue / Auto-run. */
  actions?: React.ReactNode;
  /** Shown under the list when open, e.g. the paths a member owns. */
  children?: React.ReactNode;
}) {
  const doneCount = steps.filter((s) => s.status === 'done').length;
  const current =
    steps.find((s) => s.status === 'in_progress') ??
    steps.find((s) => s.status === 'failed') ??
    steps.find((s) => s.status === 'pending');
  const currentLabel = current?.status === 'in_progress' ? 'Now' : current?.status === 'failed' ? 'Not met' : 'Next';

  return (
    <CollapsibleSection
      title={title}
      aside={countLabel(doneCount, steps.length)}
      actions={actions}
      peek={(open) => (
        <div className="space-y-1.5">
          <div className="h-1 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full bg-success transition-all"
              style={{ width: `${steps.length ? (doneCount / steps.length) * 100 : 0}%` }}
            />
          </div>
          {!open && current && (
            <div className="flex items-start gap-2 text-xs text-muted-foreground" title={current.brief}>
              <StepIcon status={current.status} />
              <span className="mt-0.5 min-w-0 truncate">
                <span className="font-medium">{currentLabel}:</span> <span className="text-foreground">{current.title}</span>
              </span>
            </div>
          )}
        </div>
      )}
    >
      <ul className="space-y-1.5 max-h-48 overflow-y-auto custom-scrollbar">
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
            <StepIcon status={step.status} />
            <span title={step.brief}>{step.title}</span>
          </li>
        ))}
      </ul>
      {children && <div className="mt-3 space-y-2">{children}</div>}
    </CollapsibleSection>
  );
}
