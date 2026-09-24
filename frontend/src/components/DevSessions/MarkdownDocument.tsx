'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// Agent-written docs start with a YAML frontmatter block (status, ticket,
// related-docs, ...). Shown as a compact key/value strip above the rendered
// body rather than as a literal code fence.
function splitFrontmatter(markdown: string): { fields: [string, string][]; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(markdown);
  if (!match) return { fields: [], body: markdown };
  const fields: [string, string][] = [];
  let lastKey: string | null = null;
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line);
    if (kv) {
      lastKey = kv[1];
      fields.push([kv[1], kv[2].replace(/^['"]|['"]$/g, '')]);
    } else if (lastKey && /^\s*-\s+/.test(line)) {
      const last = fields[fields.length - 1];
      const item = line.replace(/^\s*-\s+/, '').replace(/^['"]|['"]$/g, '');
      last[1] = last[1] && last[1] !== '[]' ? `${last[1]}, ${item}` : item;
    }
  }
  return { fields, body: markdown.slice(match[0].length) };
}

export function MarkdownDocument({ markdown }: { markdown: string }) {
  const { fields, body } = splitFrontmatter(markdown);
  const visible = fields.filter(([, value]) => value && value !== '[]');

  return (
    <div>
      {visible.length > 0 && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 mb-4 pb-3 border-b border-gray-100 text-xs text-gray-500">
          {visible.map(([key, value]) => (
            <span key={key}>
              <span className="font-medium text-gray-600">{key}:</span> {value}
            </span>
          ))}
        </div>
      )}
      <div className="prose prose-sm max-w-none prose-headings:text-gray-900 prose-pre:bg-gray-900 prose-pre:text-gray-100 prose-code:before:content-none prose-code:after:content-none">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown>
      </div>
    </div>
  );
}
