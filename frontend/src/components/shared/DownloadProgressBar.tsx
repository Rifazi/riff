"use client";

import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

interface DownloadProgressBarProps {
  /** What is being downloaded, e.g. "Downloading gemma3:1b". */
  label: string;
  /** Completion percentage, 0-100. */
  percent: number;
  className?: string;
}

/**
 * The label + percentage + bar row used wherever a model download reports
 * progress. Colors come from the theme via `ui/progress` and the `primary`
 * token, so there is no per-call-site styling to keep in sync.
 */
export function DownloadProgressBar({
  label,
  percent,
  className,
}: DownloadProgressBarProps) {
  const clamped = Math.min(100, Math.max(0, percent));

  return (
    <div className={cn("w-full", className)}>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-medium text-primary">{label}</span>
        <span className="text-sm font-semibold text-primary">
          {Math.round(clamped)}%
        </span>
      </div>
      <Progress value={clamped} aria-label={label} />
    </div>
  );
}
