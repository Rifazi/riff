'use client';

import { NotebookPen } from 'lucide-react';
import type { QaNote } from '@/lib/dev-sessions/types';
import { AGENT_PERSONAS } from '@/lib/dev-sessions/agents';
import { CollapsibleSection } from './CollapsibleSection';

/** Notes the coding agent left for QA with note_for_qa: waiting on the Coding tab, handed over on the QA tab. */
export function QaNotes({ notes, title, bare }: { notes: QaNote[]; title: string; bare?: boolean }) {
  if (!notes.length) return null;
  return (
    <CollapsibleSection icon={NotebookPen} title={title} aside={notes.length} bare={bare}>
      <ul className="space-y-1 text-sm max-h-48 overflow-y-auto custom-scrollbar">
        {notes.map((n) => (
          <li key={n.id} className="text-foreground">
            <span className="text-muted-foreground">{n.from ?? AGENT_PERSONAS.coding.name}:</span> {n.text}
          </li>
        ))}
      </ul>
    </CollapsibleSection>
  );
}
