'use client';

import { Fragment } from 'react';
import { Sparkles } from 'lucide-react';
import { SNIPPET_MARK_END, SNIPPET_MARK_START, type SearchHit } from '@/lib/search/api';
import { formatOffset } from '@/lib/journal/format';

/** The excerpt with matched words highlighted. */
export function SearchSnippet({ snippet, className = '' }: { snippet: string; className?: string }) {
  const parts = snippet.split(SNIPPET_MARK_START);
  return (
    <span className={className}>
      {parts.map((part, i) => {
        if (i === 0) return <Fragment key={i}>{part}</Fragment>;
        const [marked, rest = ''] = part.split(SNIPPET_MARK_END);
        return (
          <Fragment key={i}>
            <mark className="rounded-sm bg-warning/30 px-0.5 text-inherit">{marked}</mark>
            {rest}
          </Fragment>
        );
      })}
    </span>
  );
}

/** Where in a meeting or journal the match is: "Transcript · 12:04", "Summary · Decisions". */
export function hitLocation(hit: SearchHit): string {
  switch (hit.kind) {
    case 'transcript': {
      const at = formatOffset(hit.start);
      return at ? `Transcript · ${at}` : 'Transcript';
    }
    case 'summary':
      return hit.heading ? `Summary · ${hit.heading}` : 'Summary';
    case 'journal_note':
      return `Note · ${hit.title}`;
    case 'journal':
      return hit.heading ? `Overview · ${hit.heading}` : 'Overview';
  }
}

/** One line per match: where it is, then the excerpt. */
export function SearchHitLines({ hit, max = 2 }: { hit: SearchHit; max?: number }) {
  const hits = [hit, ...(hit.also ?? [])].slice(0, max);
  return (
    <div className="mt-1 space-y-0.5">
      {hits.map((h) => (
        <div
          key={`${h.key}:${h.start ?? ''}:${h.heading ?? ''}:${h.snippet.slice(0, 20)}`}
          className="text-xs text-muted-foreground line-clamp-2"
        >
          <span className="font-medium text-foreground">{hitLocation(h)}</span>
          {h.semantic && !h.keyword && (
            <span
              className="ml-1.5 inline-flex items-center gap-0.5 text-primary"
              title="Matched by meaning, not by the exact words"
            >
              <Sparkles className="h-3 w-3" /> related
            </span>
          )}
          <span className="mx-1.5 text-muted-foreground/50">—</span>
          <SearchSnippet snippet={h.snippet} />
        </div>
      ))}
    </div>
  );
}
