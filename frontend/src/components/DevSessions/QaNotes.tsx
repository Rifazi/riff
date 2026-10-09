'use client';

import { NotebookPen } from 'lucide-react';
import type { QaNote } from '@/lib/dev-sessions/types';
import { AGENT_PERSONAS } from '@/lib/dev-sessions/agents';

/** Notes the coding agent left for QA with note_for_qa: waiting on the Coding tab, handed over on the QA tab. */
export function QaNotes({ notes, title }: { notes: QaNote[]; title: string }) {
  if (!notes.length) return null;
  return (
    <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
      <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">
        <NotebookPen className="w-3.5 h-3.5" />
        {title}
      </div>
      <ul className="space-y-1">
        {notes.map((n) => (
          <li key={n.id} className="text-foreground">
            <span className="text-muted-foreground">{n.from ?? AGENT_PERSONAS.coding.name}:</span> {n.text}
          </li>
        ))}
      </ul>
    </div>
  );
}
