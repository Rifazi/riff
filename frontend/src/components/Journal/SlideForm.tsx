'use client';

import { Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import type { DeckSlide } from '@/lib/decks/api';

type Set = (patch: Partial<DeckSlide>) => void;

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function Text({
  label,
  value,
  onChange,
  max,
  area,
}: {
  label: string;
  value: string | undefined;
  onChange: (v: string) => void;
  max: number;
  area?: boolean;
}) {
  const Control = area ? Textarea : Input;
  return (
    <Field label={label}>
      <Control value={value ?? ''} maxLength={max} onChange={(e) => onChange(e.target.value)} />
    </Field>
  );
}

/** A list of one-line strings: edit in place, remove, add up to `max`. */
function Lines({
  label,
  items,
  onChange,
  min,
  max,
  limit,
}: {
  label: string;
  items: string[];
  onChange: (v: string[]) => void;
  min: number;
  max: number;
  limit: number;
}) {
  return (
    <Field label={label}>
      <div className="space-y-1">
        {items.map((b, i) => (
          <div key={i} className="flex gap-1">
            <Input
              value={b}
              maxLength={limit}
              onChange={(e) => onChange(items.map((x, j) => (j === i ? e.target.value : x)))}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Remove"
              disabled={items.length <= min}
              onClick={() => onChange(items.filter((_, j) => j !== i))}
            >
              <X />
            </Button>
          </div>
        ))}
        {items.length < max && (
          <Button type="button" variant="outline" size="sm" onClick={() => onChange([...items, ''])}>
            <Plus /> Add
          </Button>
        )}
      </div>
    </Field>
  );
}

function Rows<T>({
  label,
  rows,
  onChange,
  make,
  min,
  max,
  render,
}: {
  label: string;
  rows: T[];
  onChange: (v: T[]) => void;
  make: () => T;
  min: number;
  max: number;
  render: (row: T, set: (patch: Partial<T>) => void) => React.ReactNode;
}) {
  return (
    <Field label={label}>
      <div className="space-y-1">
        {rows.map((row, i) => (
          <div key={i} className="flex gap-1">
            <div className="flex min-w-0 flex-1 gap-1">
              {render(row, (patch) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r))))}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Remove"
              disabled={rows.length <= min}
              onClick={() => onChange(rows.filter((_, j) => j !== i))}
            >
              <X />
            </Button>
          </div>
        ))}
        {rows.length < max && (
          <Button type="button" variant="outline" size="sm" onClick={() => onChange([...rows, make()])}>
            <Plus /> Add
          </Button>
        )}
      </div>
    </Field>
  );
}

const cell = (value: string, onChange: (v: string) => void, max: number, placeholder: string, className = '') => (
  <Input
    className={className}
    value={value}
    maxLength={max}
    placeholder={placeholder}
    onChange={(e) => onChange(e.target.value)}
  />
);

function Column({
  label,
  side,
  onChange,
}: {
  label: string;
  side: { heading: string; bullets: string[] } | undefined;
  onChange: (v: { heading: string; bullets: string[] }) => void;
}) {
  const value = side ?? { heading: '', bullets: [''] };
  return (
    <div className="space-y-2 rounded border border-border p-2">
      <Text
        label={`${label} heading`}
        value={value.heading}
        max={30}
        onChange={(heading) => onChange({ ...value, heading })}
      />
      <Lines
        label={`${label} bullets`}
        items={value.bullets}
        min={1}
        max={3}
        limit={70}
        onChange={(bullets) => onChange({ ...value, bullets })}
      />
    </div>
  );
}

/** The fields of one slide, by layout. Limits match the server's box sizes; it shortens anything longer. */
export function SlideForm({ slide, onChange }: { slide: DeckSlide; onChange: Set }) {
  const { layout } = slide;
  const hasTitle = !['quote', 'statement'].includes(layout);
  const columns = slide.columns ?? [];
  return (
    <div className="space-y-3">
      {hasTitle && <Text label="Title" value={slide.title} max={70} onChange={(title) => onChange({ title })} />}
      {(layout === 'title' || layout === 'section' || layout === 'statement') && (
        <Text
          label="Subtitle (optional)"
          value={slide.subtitle}
          max={100}
          onChange={(subtitle) => onChange({ subtitle: subtitle || undefined })}
        />
      )}
      {layout === 'statement' && (
        <Text label="Statement" value={slide.statement} max={110} onChange={(statement) => onChange({ statement })} />
      )}
      {layout === 'quote' && (
        <>
          <Text label="Quote" area value={slide.quote} max={160} onChange={(quote) => onChange({ quote })} />
          <Text
            label="Attribution (optional)"
            value={slide.attribution}
            max={80}
            onChange={(attribution) => onChange({ attribution: attribution || undefined })}
          />
        </>
      )}
      {(layout === 'bullets' || layout === 'closing') && (
        <Lines
          label="Bullets"
          items={slide.bullets ?? []}
          min={layout === 'closing' ? 0 : 1}
          max={layout === 'closing' ? 3 : 4}
          limit={80}
          onChange={(bullets) => onChange({ bullets })}
        />
      )}
      {layout === 'two_column' && (
        <div className="grid gap-2 sm:grid-cols-2">
          <Column label="Left" side={slide.left} onChange={(left) => onChange({ left })} />
          <Column label="Right" side={slide.right} onChange={(right) => onChange({ right })} />
        </div>
      )}
      {layout === 'stat' && (
        <Rows
          label="Numbers"
          rows={slide.stats ?? []}
          min={1}
          max={3}
          make={() => ({ value: '', label: '' })}
          onChange={(stats) => onChange({ stats })}
          render={(r, set) => (
            <>
              {cell(r.value, (value) => set({ value }), 12, 'Value', 'w-24')}
              {cell(r.label, (label) => set({ label }), 50, 'Label')}
            </>
          )}
        />
      )}
      {layout === 'table' && (
        <>
          <Lines
            label="Columns"
            items={columns}
            min={2}
            max={4}
            limit={24}
            onChange={(cols) =>
              onChange({ columns: cols, rows: (slide.rows ?? []).map((r) => cols.map((_, i) => r[i] ?? '')) })
            }
          />
          <Field label="Rows">
            <div className="space-y-1">
              {(slide.rows ?? []).map((row, i) => (
                <div key={i} className="flex gap-1">
                  {columns.map((_, c) => (
                    <div key={c} className="min-w-0 flex-1">
                      {cell(
                        row[c] ?? '',
                        (v) =>
                          onChange({
                            rows: (slide.rows ?? []).map((r, j) => (j === i ? r.map((x, k) => (k === c ? v : x)) : r)),
                          }),
                        40,
                        columns[c] || 'Cell',
                      )}
                    </div>
                  ))}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="Remove row"
                    disabled={(slide.rows ?? []).length <= 1}
                    onClick={() => onChange({ rows: (slide.rows ?? []).filter((_, j) => j !== i) })}
                  >
                    <X />
                  </Button>
                </div>
              ))}
              {(slide.rows ?? []).length < 5 && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => onChange({ rows: [...(slide.rows ?? []), columns.map(() => '')] })}
                >
                  <Plus /> Add row
                </Button>
              )}
            </div>
          </Field>
        </>
      )}
      {layout === 'timeline' && (
        <Rows
          label="Events"
          rows={slide.events ?? []}
          min={2}
          max={5}
          make={() => ({ when: '', label: '' })}
          onChange={(events) => onChange({ events })}
          render={(r, set) => (
            <>
              {cell(r.when, (when) => set({ when }), 14, 'When', 'w-28')}
              {cell(r.label, (label) => set({ label }), 48, 'What happens')}
            </>
          )}
        />
      )}
      {layout === 'process' && (
        <Rows
          label="Steps"
          rows={slide.steps ?? []}
          min={2}
          max={4}
          make={() => ({ title: '', detail: undefined as string | undefined })}
          onChange={(steps) => onChange({ steps })}
          render={(r, set) => (
            <>
              {cell(r.title, (title) => set({ title }), 24, 'Step', 'w-40')}
              {cell(r.detail ?? '', (detail) => set({ detail: detail || undefined }), 60, 'Detail (optional)')}
            </>
          )}
        />
      )}
      {layout === 'bar_chart' && (
        <>
          <Rows
            label="Bars"
            rows={slide.items ?? []}
            min={2}
            max={6}
            make={() => ({ label: '', value: 0, display: undefined as string | undefined })}
            onChange={(items) => onChange({ items })}
            render={(r, set) => (
              <>
                {cell(r.label, (label) => set({ label }), 28, 'Label')}
                <Input
                  className="w-24"
                  type="number"
                  min={0}
                  value={r.value ?? 0}
                  onChange={(e) => set({ value: Math.max(0, Number(e.target.value) || 0) })}
                />
                {cell(r.display ?? '', (display) => set({ display: display || undefined }), 12, 'Shown as', 'w-24')}
              </>
            )}
          />
          <Text
            label="Caption (optional)"
            value={slide.caption}
            max={80}
            onChange={(caption) => onChange({ caption: caption || undefined })}
          />
        </>
      )}
      {layout === 'status_list' && (
        <Rows
          label="Items"
          rows={slide.items ?? []}
          min={2}
          max={5}
          make={() => ({ label: '', status: 'open' as const })}
          onChange={(items) => onChange({ items })}
          render={(r, set) => (
            <>
              {cell(r.label, (label) => set({ label }), 64, 'Item')}
              <select
                className="h-9 rounded-md border border-input bg-transparent px-2 text-sm"
                value={r.status ?? 'open'}
                onChange={(e) => set({ status: e.target.value as 'done' | 'open' | 'risk' })}
              >
                <option value="done">Done</option>
                <option value="open">Open</option>
                <option value="risk">At risk</option>
              </select>
            </>
          )}
        />
      )}
      <Text
        label="Speaker notes (optional)"
        area
        value={slide.notes}
        max={1500}
        onChange={(notes) => onChange({ notes: notes || undefined })}
      />
    </div>
  );
}
