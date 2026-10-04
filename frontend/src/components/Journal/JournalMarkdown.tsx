'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const CITATION = /\[(\d+(?:\s*,\s*\d+)*)\](?!\()/g;

/** Turns "[1, 3]" citations into links the renderer below shows as chips. */
function linkCitations(markdown: string) {
  return markdown.replace(CITATION, (_, ids: string) =>
    ids
      .split(',')
      .map((id) => `[${id.trim()}](#cite-${id.trim()})`)
      .join(''),
  );
}

interface JournalMarkdownProps {
  markdown: string;
  /** When set, [n] citations render as clickable chips. */
  onCite?: (id: number) => void;
  citedIds?: Set<number>;
}

export function JournalMarkdown({ markdown, onCite, citedIds }: JournalMarkdownProps) {
  return (
    <div className="prose prose-sm max-w-none prose-headings:font-semibold prose-h2:text-base prose-h2:mt-5 prose-h2:mb-2 prose-p:my-2 prose-li:my-0.5">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => {
            const match = href ? /^#cite-(\d+)$/.exec(href) : null;
            if (match && onCite) {
              const id = Number(match[1]);
              const known = !citedIds || citedIds.has(id);
              return (
                <button
                  type="button"
                  onClick={() => onCite(id)}
                  className={`mx-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded px-1 align-text-top text-[10px] font-semibold no-underline ${known ? 'bg-primary/15 text-primary hover:bg-primary/25' : 'bg-muted text-muted-foreground'}`}
                >
                  {id}
                </button>
              );
            }
            return (
              <a href={href} target="_blank" rel="noreferrer">
                {children}
              </a>
            );
          },
        }}
      >
        {onCite ? linkCitations(markdown) : markdown}
      </ReactMarkdown>
    </div>
  );
}
