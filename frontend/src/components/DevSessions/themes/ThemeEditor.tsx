'use client';

import { useEffect, useState } from 'react';
import type { Density, ThemeColors, ThemeDefinition, ThemeMode } from '@/lib/dev-sessions/types';

// Edits every field of a ThemeDefinition, i.e. of the app's theme/theme.json.
// Colors are edited for the mode being previewed.

const COLOR_FIELDS: { key: keyof ThemeColors; label: string }[] = [
  { key: 'primary', label: 'Primary' },
  { key: 'onPrimary', label: 'Text on primary' },
  { key: 'bg', label: 'Page background' },
  { key: 'surface', label: 'Surface (cards, inputs)' },
  { key: 'surfaceMuted', label: 'Muted surface' },
  { key: 'border', label: 'Border' },
  { key: 'text', label: 'Text' },
  { key: 'textMuted', label: 'Muted text' },
  { key: 'success', label: 'Success' },
  { key: 'warning', label: 'Warning' },
  { key: 'danger', label: 'Danger' },
  { key: 'info', label: 'Info' },
];

const SYSTEM_SANS = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const SYSTEM_MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';
const FONT_SUGGESTIONS = [
  SYSTEM_SANS,
  `Inter, ${SYSTEM_SANS}`,
  `"Plus Jakarta Sans", Inter, ${SYSTEM_SANS}`,
  `"IBM Plex Sans", ${SYSTEM_SANS}`,
  '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif',
  'Georgia, "Times New Roman", serif',
  `"JetBrains Mono", ${SYSTEM_MONO}`,
  SYSTEM_MONO,
];

const SHADOW_PRESETS: { label: string; sm: string; md: string }[] = [
  { label: 'None', sm: 'none', md: 'none' },
  { label: 'Subtle', sm: '0 1px 2px rgb(0 0 0 / 0.05)', md: '0 2px 6px rgb(0 0 0 / 0.08)' },
  {
    label: 'Soft',
    sm: '0 1px 2px rgb(15 23 42 / 0.06), 0 1px 3px rgb(15 23 42 / 0.08)',
    md: '0 4px 12px rgb(15 23 42 / 0.10), 0 2px 4px rgb(15 23 42 / 0.06)',
  },
  { label: 'Lifted', sm: '0 2px 6px rgb(0 0 0 / 0.10)', md: '0 12px 32px rgb(0 0 0 / 0.18)' },
  { label: 'Offset', sm: 'none', md: '4px 4px 0 currentColor' },
];

const inputClass =
  'w-full rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="space-y-2 border-t border-border pt-3 first:border-0 first:pt-0">
      <legend className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</legend>
      {children}
    </fieldset>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid grid-cols-[104px_minmax(0,1fr)] items-center gap-2 text-xs text-foreground">
      <span>{label}</span>
      {children}
    </label>
  );
}

// Text stays local while typing, so a half-typed hex doesn't reach the theme.
function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (hex: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <Row label={label}>
      <span className="flex items-center gap-1.5">
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-6 w-8 flex-shrink-0 cursor-pointer rounded border border-border bg-background p-0.5"
          aria-label={`${label} color`}
        />
        <input
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (/^#[0-9a-fA-F]{6}$/.test(e.target.value)) onChange(e.target.value.toLowerCase());
          }}
          onBlur={() => setText(value)}
          className={`${inputClass} font-mono`}
          spellCheck={false}
        />
      </span>
    </Row>
  );
}

function RangeField({
  label,
  value,
  max,
  onChange,
}: {
  label: string;
  value: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <Row label={label}>
      <span className="flex items-center gap-2">
        <input
          type="range"
          min={0}
          max={max}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="flex-1"
        />
        <span className="w-9 text-right tabular-nums text-muted-foreground">{value}px</span>
      </span>
    </Row>
  );
}

export function ThemeEditor({
  theme,
  mode,
  onChange,
}: {
  theme: ThemeDefinition;
  mode: ThemeMode;
  onChange: (theme: ThemeDefinition) => void;
}) {
  const set = <K extends keyof ThemeDefinition>(key: K, value: ThemeDefinition[K]) =>
    onChange({ ...theme, [key]: value });
  const shadowPreset =
    SHADOW_PRESETS.find((s) => s.sm === theme.shadow.sm && s.md === theme.shadow.md)?.label ?? 'Custom';
  const pill = theme.radius.full >= 999;

  return (
    <div className="space-y-4">
      <Section title="Theme">
        <Row label="Name">
          <input value={theme.name} onChange={(e) => set('name', e.target.value)} className={inputClass} />
        </Row>
        <Row label="Description">
          <input
            value={theme.description}
            onChange={(e) => set('description', e.target.value)}
            className={inputClass}
          />
        </Row>
      </Section>

      <Section title={`Colors · ${mode} mode`}>
        {COLOR_FIELDS.map(({ key, label }) => (
          <ColorField
            key={key}
            label={label}
            value={theme[mode][key]}
            onChange={(hex) => set(mode, { ...theme[mode], [key]: hex })}
          />
        ))}
        <p className="text-[11px] text-muted-foreground">
          Switch the preview to {mode === 'light' ? 'dark' : 'light'} to edit its colors.
        </p>
      </Section>

      <Section title="Typography">
        <datalist id="theme-font-stacks">
          {FONT_SUGGESTIONS.map((stack) => (
            <option key={stack} value={stack} />
          ))}
        </datalist>
        {(['sans', 'heading', 'mono'] as const).map((key) => (
          <Row key={key} label={{ sans: 'Body font', heading: 'Heading font', mono: 'Code font' }[key]}>
            <input
              list="theme-font-stacks"
              value={theme.fonts[key]}
              onChange={(e) => set('fonts', { ...theme.fonts, [key]: e.target.value })}
              className={inputClass}
              spellCheck={false}
            />
          </Row>
        ))}
        <Row label="Heading weight">
          <select
            value={theme.headingWeight}
            onChange={(e) => set('headingWeight', Number(e.target.value))}
            className={inputClass}
          >
            {[400, 500, 600, 650, 700, 800].map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
          </select>
        </Row>
      </Section>

      <Section title="Shape">
        <RangeField
          label="Small corners"
          value={theme.radius.sm}
          max={24}
          onChange={(v) => set('radius', { ...theme.radius, sm: v })}
        />
        <RangeField
          label="Corners"
          value={theme.radius.md}
          max={24}
          onChange={(v) => set('radius', { ...theme.radius, md: v })}
        />
        <RangeField
          label="Card corners"
          value={theme.radius.lg}
          max={32}
          onChange={(v) => set('radius', { ...theme.radius, lg: v })}
        />
        <Row label="Pills">
          <span className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={pill}
              onChange={(e) => set('radius', { ...theme.radius, full: e.target.checked ? 9999 : theme.radius.md })}
            />
            <span className="text-muted-foreground">Fully round badges, switches and avatars</span>
          </span>
        </Row>
        <Row label="Border width">
          <select
            value={theme.borderWidth}
            onChange={(e) => set('borderWidth', Number(e.target.value))}
            className={inputClass}
          >
            {[1, 2, 3].map((w) => (
              <option key={w} value={w}>
                {w}px
              </option>
            ))}
          </select>
        </Row>
        <Row label="Shadows">
          <select
            value={shadowPreset}
            onChange={(e) => {
              const preset = SHADOW_PRESETS.find((s) => s.label === e.target.value);
              if (preset) set('shadow', { sm: preset.sm, md: preset.md });
            }}
            className={inputClass}
          >
            {SHADOW_PRESETS.map((s) => (
              <option key={s.label}>{s.label}</option>
            ))}
            {shadowPreset === 'Custom' && <option>Custom</option>}
          </select>
        </Row>
      </Section>

      <Section title="Spacing">
        <Row label="Density">
          <select
            value={theme.density}
            onChange={(e) => set('density', e.target.value as Density)}
            className={inputClass}
          >
            <option value="compact">Compact</option>
            <option value="comfortable">Comfortable</option>
            <option value="spacious">Spacious</option>
          </select>
        </Row>
      </Section>
    </div>
  );
}
