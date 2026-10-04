import type { ClassificationCacheEntry } from '@/lib/dev-sessions/types';

const UNITS = ['B', 'KB', 'MB', 'GB'] as const;

/**
 * Human-readable download size for a cached classification model. Binary
 * units, one decimal below 100 so "71.4 MB" stays readable while "402 MB"
 * doesn't carry noise.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), UNITS.length - 1);
  const value = bytes / 1024 ** exponent;
  const rounded = exponent === 0 || value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${UNITS[exponent]}`;
}

/** Total disk the classification cache is using across every cached model. */
export function totalCachedBytes(entries: ClassificationCacheEntry[]): number {
  return entries.reduce((total, entry) => total + (entry.downloaded ? entry.sizeBytes : 0), 0);
}
