// Dates, recording offsets and notebook cover colors for the Journal views.

export function formatOffset(seconds: number | null | undefined): string | null {
  if (seconds == null || !Number.isFinite(seconds)) return null;
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mmss = `${String(m).padStart(h ? 2 : 1, '0')}:${String(s).padStart(2, '0')}`;
  return h ? `${h}:${mmss}` : mmss;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

export function formatShortDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

/** Wall-clock time a moment of the recording happened: meeting start + offset. */
export function formatClock(startedAt: string, offsetSeconds: number | null | undefined): string {
  const start = new Date(startedAt);
  if (Number.isNaN(start.getTime())) return '';
  const at = new Date(start.getTime() + (offsetSeconds ?? 0) * 1000);
  return at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** e.g. "Tue, Sep 30, 2026 · 2:14 PM · 12:30–15:10 in recording" */
export function describeMoment(startedAt: string, start: number | null, end: number | null): string {
  const parts = [formatDate(startedAt), formatClock(startedAt, start)];
  const range = [formatOffset(start), formatOffset(end)].filter(Boolean).join('–');
  if (range) parts.push(`${range} in recording`);
  return parts.filter(Boolean).join(' · ');
}

export function relativeDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const days = Math.floor((Date.now() - date.getTime()) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return formatShortDate(iso);
}

interface CoverColor {
  spine: string;
  cover: string;
  ink: string;
  dot: string;
}

// THEME CARVE-OUT: these are deliberately literal palette classes, not theme
// tokens. A notebook's color is user-chosen data (like a folder label colour) —
// it's picked per notebook and stored in the database, and its whole purpose is
// to tell notebooks apart at a glance on the shelf. Mapping it onto the theme's
// single primary colour would delete that feature, so this map is the one place
// in frontend/src allowed to name palette colours; the palette-regression guard
// in frontend/tests/theme/no-palette-classes.test.ts allowlists this file.
// Everything that renders *around* a swatch (text, borders, chrome) still uses
// theme tokens — see NotebookCover.
// Full class strings so Tailwind keeps them. Keys match NOTEBOOK_COLORS in repository.rs.
export const NOTEBOOK_COLORS: Record<string, CoverColor> = {
  indigo: { spine: 'bg-indigo-600', cover: 'bg-indigo-50', ink: 'text-indigo-900', dot: 'bg-indigo-500' },
  emerald: { spine: 'bg-emerald-600', cover: 'bg-emerald-50', ink: 'text-emerald-900', dot: 'bg-emerald-500' },
  amber: { spine: 'bg-amber-500', cover: 'bg-amber-50', ink: 'text-amber-900', dot: 'bg-amber-500' },
  rose: { spine: 'bg-rose-600', cover: 'bg-rose-50', ink: 'text-rose-900', dot: 'bg-rose-500' },
  sky: { spine: 'bg-sky-600', cover: 'bg-sky-50', ink: 'text-sky-900', dot: 'bg-sky-500' },
  violet: { spine: 'bg-violet-600', cover: 'bg-violet-50', ink: 'text-violet-900', dot: 'bg-violet-500' },
  teal: { spine: 'bg-teal-600', cover: 'bg-teal-50', ink: 'text-teal-900', dot: 'bg-teal-500' },
  orange: { spine: 'bg-orange-500', cover: 'bg-orange-50', ink: 'text-orange-900', dot: 'bg-orange-500' },
  slate: { spine: 'bg-slate-600', cover: 'bg-slate-100', ink: 'text-slate-900', dot: 'bg-slate-500' },
  pink: { spine: 'bg-pink-600', cover: 'bg-pink-50', ink: 'text-pink-900', dot: 'bg-pink-500' },
};

export function coverColor(color: string): CoverColor {
  return NOTEBOOK_COLORS[color] ?? NOTEBOOK_COLORS.indigo;
}
