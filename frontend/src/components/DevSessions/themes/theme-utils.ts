import type { ThemeDefinition, ThemeMode } from '@/lib/dev-sessions/types';

// Key-order-independent, like the server's sameTheme, so a theme that
// round-tripped through theme.json still matches its preset.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical((value as Record<string, unknown>)[k])]));
  }
  return value;
}

export function sameTheme(a: ThemeDefinition, b: ThemeDefinition): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

export function swatches(theme: ThemeDefinition, mode: ThemeMode): string[] {
  const c = theme[mode];
  return [c.primary, c.surface, c.text, c.success, c.danger];
}
