'use client';

import { Check, Download } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { ClassificationCacheEntry, ClassificationModelOption } from '@/lib/dev-sessions/types';
import { formatBytes } from './cache-size';

/**
 * One curated model's cache state: downloaded or not, and what it costs on
 * disk. Secondary detail next to the picker — readable at a glance, never
 * competing with it.
 */
export function ModelCacheRow({
  option,
  entry,
  selected,
}: {
  option: ClassificationModelOption;
  entry: ClassificationCacheEntry | undefined;
  selected: boolean;
}) {
  const downloaded = entry?.downloaded ?? false;

  return (
    <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 py-2">
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-sm text-foreground">
          <span className="font-mono text-xs break-all">{option.id}</span>
          {selected && <Badge variant="secondary">Selected</Badge>}
        </div>
        <div className="text-xs text-muted-foreground">{option.description}</div>
      </div>
      <div
        className={`flex items-center gap-1.5 text-xs whitespace-nowrap ${
          downloaded ? 'text-success' : 'text-muted-foreground'
        }`}
      >
        {downloaded ? (
          <>
            <Check className="w-3.5 h-3.5" aria-hidden />
            <span>Downloaded · {formatBytes(entry?.sizeBytes ?? 0)}</span>
          </>
        ) : (
          <>
            <Download className="w-3.5 h-3.5" aria-hidden />
            <span>Not downloaded</span>
          </>
        )}
      </div>
    </div>
  );
}
