'use client';

import { ChevronRight, NotebookPen } from 'lucide-react';
import type { QaNote } from '@/lib/dev-sessions/types';
import { AGENT_PERSONAS } from '@/lib/dev-sessions/agents';

/**
 * Notes the coding agent left for QA with note_for_qa: waiting on the Coding tab, handed over on the QA tab.
 * Collapsed by default and height-capped when open: it sits above the approve bar, which must stay on screen.
 */
export function QaNotes({ notes, title }: { notes: QaNote[]; title: string }) {
  if (!notes.length) return null;
  return (
    <details className="group flex-shrink-0 rounded-md border border-border bg-muted/40 text-sm">
      <summary className="flex items-center gap-1.5 px-3 py-2 cursor-pointer select-none list-none text-xs font-semibold text-muted-foreground uppercase tracking-wide">
        <ChevronRight className="w-3.5 h-3.5 transition-transform group-open:rotate-90 flex-shrink-0" />
        <NotebookPen className="w-3.5 h-3.5" />
        {title}
        <span className="normal-case font-normal tracking-normal">
          ({notes.length} {notes.length === 1 ? 'note' : 'notes'})
        </span>
      </summary>
      <ul className="space-y-1 px-3 pb-2 max-h-[30vh] overflow-y-auto">
        {notes.map((n) => (
          <li key={n.id} className="text-foreground">
            <span className="text-muted-foreground">{n.from ?? AGENT_PERSONAS.coding.name}:</span> {n.text}
          </li>
        ))}
      </ul>
    </details>
  );
}
