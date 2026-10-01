'use client';

import Link from 'next/link';
import { Sparkles } from 'lucide-react';
import { notebookHref, type NotebookOverview } from '@/lib/journal/api';
import { coverColor, relativeDate } from '@/lib/journal/format';

/** A notebook on the shelf: colored spine, topic title, and its latest notes. */
export function NotebookCover({ notebook }: { notebook: NotebookOverview }) {
  const color = coverColor(notebook.color);

  return (
    <Link
      href={notebookHref(notebook.id)}
      className={`group relative flex h-64 overflow-hidden rounded-r-xl rounded-l-md border border-black/5 shadow-sm transition-all duration-200 hover:-translate-y-1 hover:shadow-lg ${color.cover}`}
    >
      {/* Spine */}
      <div className={`w-4 flex-shrink-0 ${color.spine}`}>
        <div className="mt-6 h-px bg-white/30" />
        <div className="mt-1 h-px bg-white/30" />
      </div>

      <div className="flex min-w-0 flex-1 flex-col p-5">
        <div className="flex items-start justify-between gap-2">
          <h3 className={`font-serif text-lg font-semibold leading-snug line-clamp-2 ${color.ink}`}>{notebook.title}</h3>
          {notebook.is_software && (
            <span className="mt-1 flex-shrink-0 rounded-full bg-purple-100 px-1.5 py-0.5 text-[10px] font-semibold text-purple-700" title="About an app: can start a Dev Session">
              App
            </span>
          )}
        </div>
        {notebook.description && (
          <p className="mt-1 text-xs text-gray-600 line-clamp-2">{notebook.description}</p>
        )}

        {/* Lined page peeking out with the latest notes */}
        <ul className="mt-4 flex-1 space-y-0 overflow-hidden rounded-md bg-white/70 px-3 py-1 text-xs text-gray-700">
          {notebook.recent_entry_titles.length === 0 && (
            <li className="py-1.5 italic text-gray-400">No notes yet</li>
          )}
          {notebook.recent_entry_titles.map((title, i) => (
            <li key={i} className="truncate border-b border-dashed border-gray-200 py-1.5 last:border-0">
              {title}
            </li>
          ))}
        </ul>

        <div className="mt-3 flex items-center justify-between text-[11px] text-gray-500">
          <span>
            {notebook.entry_count} {notebook.entry_count === 1 ? 'note' : 'notes'} · {notebook.meeting_count}{' '}
            {notebook.meeting_count === 1 ? 'meeting' : 'meetings'}
          </span>
          <span className="flex items-center gap-1">
            {notebook.summary_markdown && <Sparkles className="h-3 w-3" aria-label="Has a summary" />}
            {relativeDate(notebook.last_meeting_at)}
          </span>
        </div>
      </div>
    </Link>
  );
}
