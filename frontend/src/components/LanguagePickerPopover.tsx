'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { LANGUAGE_OPTIONS } from '@/lib/summary-languages';
import { useRecentLanguages } from '@/hooks/useRecentLanguages';

/** One selectable row in the list — the same shape for recents, Auto and all languages. */
function LanguageOptionRow({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={`flex w-full items-center justify-between px-3 py-1.5 text-sm hover:bg-muted text-left ${
        selected ? 'text-primary font-medium' : 'text-foreground'
      }`}
    >
      {children}
      {selected && (
        <span className="text-primary" aria-hidden="true">
          ✓
        </span>
      )}
    </button>
  );
}

/** The small uppercase group heading above each block of options. */
function LanguageGroupLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-3 pt-1 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </div>
  );
}

interface LanguagePickerPopoverProps {
  value: string | null;
  onChange: (code: string | null) => void;
  onClose: () => void;
  mode?: 'meeting' | 'settings';
  autoSubtitle?: string;
}

export function LanguagePickerPopover({
  value,
  onChange,
  onClose,
  mode = 'meeting',
  autoSubtitle,
}: LanguagePickerPopoverProps) {
  const { recents } = useRecentLanguages();
  const [query, setQuery] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const filter = query.trim().toLowerCase();

  const recentCodes = useMemo(() => new Set(recents), [recents]);

  const filteredAll = useMemo(() => {
    const options = mode === 'meeting' ? LANGUAGE_OPTIONS.filter((l) => !recentCodes.has(l.code)) : LANGUAGE_OPTIONS;
    if (!filter) return options;
    return options.filter((l) => l.code.toLowerCase().includes(filter) || l.label.toLowerCase().includes(filter));
  }, [filter, mode, recentCodes]);

  const recentsResolved = useMemo(
    () =>
      recents
        .map((code) => LANGUAGE_OPTIONS.find((l) => l.code === code))
        .filter((l): l is (typeof LANGUAGE_OPTIONS)[number] => Boolean(l))
        .filter((l) => !filter || l.code.toLowerCase().includes(filter) || l.label.toLowerCase().includes(filter)),
    [recents, filter],
  );

  const showAuto = mode === 'meeting' && (!filter || 'auto'.includes(filter));
  const showRecents = mode === 'meeting' && recentsResolved.length > 0;
  const hasNoResults = filteredAll.length === 0 && recentsResolved.length === 0 && !showAuto;

  return (
    <div
      ref={containerRef}
      className="w-72 rounded-lg bg-popover text-popover-foreground border border-border shadow-lg overflow-hidden"
      role="dialog"
      aria-label="Pick summary language"
    >
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border">
        <span className="text-muted-foreground text-sm">🔍</span>
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search language..."
          className="flex-1 text-sm text-foreground bg-transparent border-none outline-none placeholder:text-muted-foreground"
        />
      </div>

      <div className="max-h-80 overflow-y-auto py-1">
        {showRecents && (
          <>
            <LanguageGroupLabel>Recently Used</LanguageGroupLabel>
            {recentsResolved.map((opt) => (
              <LanguageOptionRow
                key={`recent-${opt.code}`}
                selected={value === opt.code}
                onClick={() => onChange(opt.code)}
              >
                <span>
                  {opt.label} <span className="text-xs text-muted-foreground">({opt.code})</span>
                </span>
              </LanguageOptionRow>
            ))}
            <div className="my-1 h-px bg-border" />
          </>
        )}

        {showAuto && (
          <LanguageOptionRow selected={value === null} onClick={() => onChange(null)}>
            <span className="flex flex-col">
              <span>Auto</span>
              {autoSubtitle && <span className="text-xs font-normal text-muted-foreground">{autoSubtitle}</span>}
            </span>
          </LanguageOptionRow>
        )}

        {filteredAll.length > 0 && (
          <LanguageGroupLabel>{mode === 'meeting' ? 'Other Languages' : 'All Languages'}</LanguageGroupLabel>
        )}

        {filteredAll.map((opt) => (
          <LanguageOptionRow key={`all-${opt.code}`} selected={value === opt.code} onClick={() => onChange(opt.code)}>
            <span>
              {opt.label} <span className="text-xs text-muted-foreground">({opt.code})</span>
            </span>
          </LanguageOptionRow>
        ))}

        {hasNoResults && <div className="px-3 py-2 text-sm text-muted-foreground">No matches</div>}
      </div>
    </div>
  );
}
