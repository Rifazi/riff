'use client';

import { Moon, Sun } from 'lucide-react';
import type { ThemeMode } from '@/lib/dev-sessions/types';

const MODES: { mode: ThemeMode; label: string; Icon: typeof Sun }[] = [
  { mode: 'light', label: 'Light', Icon: Sun },
  { mode: 'dark', label: 'Dark', Icon: Moon },
];

/** Switches theme previews between their light and dark tokens. */
export function ModeToggle({ mode, onChange }: { mode: ThemeMode; onChange: (mode: ThemeMode) => void }) {
  return (
    <div role="radiogroup" aria-label="Preview mode" className="inline-flex rounded-md border border-gray-200 bg-white p-0.5">
      {MODES.map(({ mode: value, label, Icon }) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={mode === value}
          onClick={() => onChange(value)}
          className={`inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium ${
            mode === value ? 'bg-gray-900 text-white' : 'text-gray-600 hover:bg-gray-100'
          }`}
        >
          <Icon className="h-3.5 w-3.5" />
          {label}
        </button>
      ))}
    </div>
  );
}
