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
  if (line.startsWith('+++') || line.startsWith('---')) return 'text-muted-foreground';
  if (line.startsWith('@@')) return 'text-primary bg-primary/10';
  if (line.startsWith('+')) return 'text-success bg-success/10';
  if (line.startsWith('-')) return 'text-destructive bg-destructive/10';
  return 'text-foreground';
}

const STATUS_CLASS: Record<FileDiff['status'], string> = {
  added: 'bg-success/10 text-success border-success/30',
  deleted: 'bg-destructive/10 text-destructive border-destructive/30',
  renamed: 'bg-primary/10 text-primary border-primary/30',
  modified: 'bg-muted text-muted-foreground border-border',
};

export function DiffViewer({ diff }: { diff: string | null }) {
  if (!diff || !diff.trim()) {
    return <div className="py-8 text-center text-sm text-muted-foreground">No diff yet.</div>;
  }
  return (
    <div className="space-y-2">
      {splitIntoFiles(diff).map((file, i) => (
        <details key={i} className="group rounded-md border border-border overflow-hidden">
          <summary className="flex items-center gap-2 px-3 py-2 bg-muted cursor-pointer select-none list-none text-sm">
            <ChevronRight className="w-3.5 h-3.5 text-muted-foreground transition-transform group-open:rotate-90 flex-shrink-0" />
            <span className="font-mono text-xs text-foreground truncate flex-1">{file.path}</span>
            <span className={`text-[11px] px-1.5 py-0.5 rounded border ${STATUS_CLASS[file.status]}`}>
              {file.status}
            </span>
            {file.additions > 0 && <span className="text-xs font-mono text-success">+{file.additions}</span>}
            {file.deletions > 0 && <span className="text-xs font-mono text-destructive">−{file.deletions}</span>}
          </summary>
          <pre className="text-xs font-mono leading-5 overflow-x-auto bg-card">
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
