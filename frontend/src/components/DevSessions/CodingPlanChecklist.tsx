import { CheckCircle2, Circle, CircleDot, XCircle } from 'lucide-react';
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

  return (
    <Card className="p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="text-sm font-semibold text-foreground">{title}</div>
        <div className="text-xs text-muted-foreground">
          {countLabel(doneCount, steps.length)}
        </div>
      </div>
      <div className="h-1.5 rounded-full bg-muted overflow-hidden mb-3">
        <div
          className="h-full bg-success transition-all"
          style={{ width: `${steps.length ? (doneCount / steps.length) * 100 : 0}%` }}
        />
      </div>
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
    </Card>
  );
}
