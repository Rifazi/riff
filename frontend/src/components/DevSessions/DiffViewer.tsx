import { ChevronRight } from 'lucide-react';

interface FileDiff {
  path: string;
  status: 'added' | 'deleted' | 'renamed' | 'modified';
  additions: number;
  deletions: number;
  lines: string[];
}

// Header line looks like "a/src/foo.ts b/src/foo.ts" (a rename: "a/old.ts b/new.ts").
function parsePath(header: string): string {
  const match = header.match(/^a\/(.*?) b\/(.*)$/);
  if (!match) return header;
  const [, before, after] = match;
  return before === after ? after : `${before} → ${after}`;
}

function splitIntoFiles(diff: string): FileDiff[] {
  return diff
    .split(/^diff --git /m)
    .filter(Boolean)
    .map((part) => {
      const lines = part.split('\n');
      const header = lines[0] ?? '';
      const bodyLines = lines.slice(1);

      let additions = 0;
      let deletions = 0;
      for (const line of bodyLines) {
        if (line.startsWith('+++') || line.startsWith('---')) continue;
        if (line.startsWith('+')) additions++;
        else if (line.startsWith('-')) deletions++;
      }

      let status: FileDiff['status'] = 'modified';
      if (bodyLines.some((l) => l.startsWith('new file mode'))) status = 'added';
      else if (bodyLines.some((l) => l.startsWith('deleted file mode'))) status = 'deleted';
      else if (bodyLines.some((l) => l.startsWith('rename from'))) status = 'renamed';

      return { path: parsePath(header), status, additions, deletions, lines: bodyLines };
    });
}

function lineClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return 'text-gray-500';
  if (line.startsWith('@@')) return 'text-purple-700 bg-purple-50';
  if (line.startsWith('+')) return 'text-green-800 bg-green-50';
  if (line.startsWith('-')) return 'text-red-800 bg-red-50';
  return 'text-gray-700';
}

const STATUS_CLASS: Record<FileDiff['status'], string> = {
  added: 'bg-green-50 text-green-700 border-green-200',
  deleted: 'bg-red-50 text-red-700 border-red-200',
  renamed: 'bg-purple-50 text-purple-700 border-purple-200',
  modified: 'bg-gray-100 text-gray-700 border-gray-200',
};

export function DiffViewer({ diff }: { diff: string | null }) {
  if (!diff || !diff.trim()) {
    return <div className="py-8 text-center text-sm text-gray-500">No diff yet.</div>;
  }
  return (
    <div className="space-y-2">
      {splitIntoFiles(diff).map((file, i) => (
        <details key={i} className="group rounded-md border border-gray-200 overflow-hidden">
          <summary className="flex items-center gap-2 px-3 py-2 bg-gray-50 cursor-pointer select-none list-none text-sm">
            <ChevronRight className="w-3.5 h-3.5 text-gray-500 transition-transform group-open:rotate-90 flex-shrink-0" />
            <span className="font-mono text-xs text-gray-800 truncate flex-1">{file.path}</span>
            <span className={`text-[11px] px-1.5 py-0.5 rounded border ${STATUS_CLASS[file.status]}`}>{file.status}</span>
            {file.additions > 0 && <span className="text-xs font-mono text-green-700">+{file.additions}</span>}
            {file.deletions > 0 && <span className="text-xs font-mono text-red-700">−{file.deletions}</span>}
          </summary>
          <pre className="text-xs font-mono leading-5 overflow-x-auto bg-white">
            {file.lines.map((line, j) => (
              <div key={j} className={`px-3 ${lineClass(line)}`}>
                {line || ' '}
              </div>
            ))}
          </pre>
        </details>
      ))}
    </div>
  );
}
