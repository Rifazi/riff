import { CheckCircle2, Circle, CircleDot } from 'lucide-react';
import type { CodingPlanStep } from '@/lib/dev-sessions/types';

export function CodingPlanChecklist({ steps }: { steps: CodingPlanStep[] }) {
  const doneCount = steps.filter((s) => s.status === 'done').length;

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="text-sm font-semibold text-gray-900">Coding checklist</div>
        <div className="text-xs text-gray-500">
          {doneCount} of {steps.length} step{steps.length === 1 ? '' : 's'} done
        </div>
      </div>
      <div className="h-1.5 rounded-full bg-gray-100 overflow-hidden mb-3">
        <div className="h-full bg-green-500 transition-all" style={{ width: `${steps.length ? (doneCount / steps.length) * 100 : 0}%` }} />
      </div>
      <ul className="space-y-1.5 max-h-40 overflow-y-auto custom-scrollbar">
        {steps.map((step) => (
          <li
            key={step.id}
            className={`flex items-start gap-2 text-sm ${
              step.status === 'done' ? 'text-gray-500' : step.status === 'in_progress' ? 'text-blue-700 font-medium' : 'text-gray-700'
            }`}
          >
            {step.status === 'done' ? (
              <CheckCircle2 className="w-4 h-4 mt-0.5 text-green-600 flex-shrink-0" />
            ) : step.status === 'in_progress' ? (
              <CircleDot className="w-4 h-4 mt-0.5 text-blue-600 flex-shrink-0" />
            ) : (
              <Circle className="w-4 h-4 mt-0.5 text-gray-300 flex-shrink-0" />
            )}
            <span>{step.title}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
