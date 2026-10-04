import { CheckCircle2, Circle, CircleDot } from 'lucide-react';
import { Card } from '@/components/ui/card';
import type { CodingPlanStep } from '@/lib/dev-sessions/types';

export function CodingPlanChecklist({
  steps,
  title = 'Coding checklist',
}: {
  steps: CodingPlanStep[];
  title?: string;
}) {
  const doneCount = steps.filter((s) => s.status === 'done').length;

  return (
    <Card className="p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="text-sm font-semibold text-foreground">{title}</div>
        <div className="text-xs text-muted-foreground">
          {doneCount} of {steps.length} step{steps.length === 1 ? '' : 's'} done
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
                  : 'text-foreground'
            }`}
          >
            {step.status === 'done' ? (
              <CheckCircle2 className="w-4 h-4 mt-0.5 text-success flex-shrink-0" />
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
