'use client';

import type { SetupSteps } from '@/lib/dev-sessions/types';
import { Notice } from './PageShell';

export interface SetupReport {
  done: string[];
  warnings: string[];
}

// Merges what one or more server-side setup steps (docs/, git, theme) did
// into one report; null when none of them did anything worth mentioning.
export function toSetupReport(done: string[], ...steps: (SetupSteps | undefined)[]): SetupReport | null {
  const allDone = [...done, ...steps.flatMap((s) => s?.actions ?? [])];
  const warnings = steps.flatMap((s) => s?.warnings ?? []);
  return allDone.length > 0 || warnings.length > 0 ? { done: allDone, warnings } : null;
}

export function SetupNotices({ report }: { report: SetupReport | null }) {
  if (!report) return null;
  return (
    <>
      {report.done.length > 0 && (
        <Notice tone="green">
          {report.done.map((line) => (
            <div key={line}>{line}</div>
          ))}
        </Notice>
      )}
      {report.warnings.map((line) => (
        <Notice key={line} tone="amber">
          {line}
        </Notice>
      ))}
    </>
  );
}
