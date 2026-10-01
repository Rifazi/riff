// rtk-style shaping of command and search output before an agent sees it.
// Every tool result stays in the conversation and is re-sent on each later
// step, so the aim is the same as rtk's: drop what the model never uses
// (colour codes, progress bars, npm banners, passing tests, repeated lines),
// group what repeats (file paths in search hits), and when a log is still
// too long keep the lines around errors plus the closing summary rather
// than a blind tail.

const ANSI_RE = /\x1b\[[0-9;?]*[ -\/]*[@-~]/g;

// Lines that carry nothing the model acts on.
const NOISE_RES = [
  /^> \S+@\S+ /, // npm's "> pkg@1.0.0 test" banner
  /^> [\w:.-]+$/, // the script line under it
  /^npm (notice|WARN deprecated|warn deprecated)/i,
  /^npm ERR! (A complete log of this run|\s*$)/,
  /^npm error (A complete log of this run|\s*$)/,
  /^\s*(✓|√|✔)\s/, // a passing test
  /^\s*PASS\s/, // jest's per-file pass line
  /^ok \d+ /, // TAP pass
  /^\s*[-\\|/]\s*$/, // spinner frame
];

const IMPORTANT_RE =
  /\b(error|errors|failed|failing|failure|fail|exception|assert(ion)?|expected|received|cannot|unable|not found|timed? ?out|panic)\b|✗|✕|×|✘|^\s*at .+:\d+:\d+\)?$|\(\d+,\d+\)|:\d+:\d+/i;

const CONTEXT_BEFORE = 2;
const CONTEXT_AFTER = 6;
const SUMMARY_LINES = 15;

/** Strip colour codes and carriage-return progress redraws, drop noise, collapse repeats. */
export function cleanLog(text: string): string[] {
  const out: string[] = [];
  let last: string | undefined;
  let repeats = 0;
  const flush = () => {
    if (repeats > 0) out[out.length - 1] += `  (×${repeats + 1})`;
    repeats = 0;
  };
  for (const raw of text.replace(ANSI_RE, '').split('\n')) {
    const line = raw.slice(raw.lastIndexOf('\r') + 1).trimEnd();
    if (NOISE_RES.some((re) => re.test(line))) continue;
    if (line === '' && (last === '' || last === undefined)) continue;
    if (line === last) {
      repeats++;
      continue;
    }
    flush();
    out.push(line);
    last = line;
  }
  flush();
  while (out.length && out[out.length - 1] === '') out.pop();
  return out;
}

/**
 * A failed command's output, shaped to fit `maxChars`: the whole cleaned log
 * when it fits, otherwise the windows around error lines plus the last
 * lines (where runners print their summary), each marked where lines were
 * skipped.
 */
export function compactOutput(stdout: string, stderr: string, maxChars = 3000): string {
  const lines = [...cleanLog(stdout), ...cleanLog(stderr)];
  const whole = lines.join('\n');
  if (whole.length <= maxChars) return whole;

  const keep = new Uint8Array(lines.length);
  lines.forEach((line, i) => {
    if (!IMPORTANT_RE.test(line)) return;
    for (let j = Math.max(0, i - CONTEXT_BEFORE); j <= Math.min(lines.length - 1, i + CONTEXT_AFTER); j++) keep[j] = 1;
  });
  for (let j = Math.max(0, lines.length - SUMMARY_LINES); j < lines.length; j++) keep[j] = 1;

  const summaryStart = Math.max(0, lines.length - SUMMARY_LINES);
  const summary = lines.slice(summaryStart).join('\n');
  const budget = Math.max(0, maxChars - summary.length - 40);

  const excerpt: string[] = [];
  let used = 0;
  let skipped = 0;
  for (let i = 0; i < summaryStart; i++) {
    if (!keep[i] || used + lines[i].length + 1 > budget) {
      skipped++;
      continue;
    }
    if (skipped) excerpt.push(`[… ${skipped} lines skipped]`);
    skipped = 0;
    const line = lines[i].length > 400 ? `${lines[i].slice(0, 400)} […]` : lines[i];
    excerpt.push(line);
    used += line.length + 1;
  }
  if (skipped) excerpt.push(`[… ${skipped} lines skipped]`);
  return [...excerpt, summary].join('\n').slice(-maxChars);
}

const MATCH_LINE_CHARS = 200;

// Tracked files that are nearly always noise to search or review line by
// line: lockfiles, snapshots, build output, minified bundles, source maps.
// As git pathspecs, for `git grep` and `git diff`.
export const NOISE_PATHSPECS = [
  ':(exclude,glob)**/package-lock.json',
  ':(exclude,glob)**/pnpm-lock.yaml',
  ':(exclude,glob)**/yarn.lock',
  ':(exclude,glob)**/Cargo.lock',
  ':(exclude,glob)**/*.snap',
  ':(exclude,glob)**/__snapshots__/**',
  ':(exclude,glob)**/dist/**',
  ':(exclude,glob)**/build/**',
  ':(exclude,glob)**/*.min.js',
  ':(exclude,glob)**/*.map',
];

/**
 * `git grep -n -z` output (path NUL line NUL text, with `--` between
 * context hunks) grouped under each path, long lines cut.
 */
export function groupGrepOutput(stdout: string, maxLines = 120): string {
  const groups = new Map<string, string[]>();
  let count = 0;
  let lastFile: string | undefined;
  for (const line of stdout.split('\n')) {
    if (count >= maxLines) break;
    if (line === '--') {
      if (lastFile) groups.get(lastFile)!.push('  …');
      continue;
    }
    const parts = line.split('\0');
    if (parts.length < 3) continue;
    const [file, lineNo, ...rest] = parts;
    const text = rest.join(' ').trim();
    const shown = text.length > MATCH_LINE_CHARS ? `${text.slice(0, MATCH_LINE_CHARS)} […]` : text;
    if (!groups.has(file)) groups.set(file, []);
    const hits = groups.get(file)!;
    // A hunk separator right before the next file's first line says nothing.
    if (lastFile && lastFile !== file && groups.get(lastFile)!.at(-1) === '  …') groups.get(lastFile)!.pop();
    hits.push(`  ${lineNo}: ${shown}`);
    lastFile = file;
    count++;
  }
  if (lastFile && groups.get(lastFile)!.at(-1) === '  …') groups.get(lastFile)!.pop();
  const out = [...groups].map(([file, hits]) => `${file}\n${hits.join('\n')}`).join('\n');
  return count >= maxLines ? `${out}\n[more matches not shown — narrow the query or pass glob]` : out;
}

/**
 * A `git diff` with its per-file header shrunk to one line: `diff --git`,
 * `index` and the `---`/`+++` pair become `### path`, keeping the lines
 * that say a file was added, deleted or renamed.
 */
export function compactDiff(diff: string): string {
  const out: string[] = [];
  let inHeader = false;
  for (const line of diff.split('\n')) {
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (header) {
      out.push(`### ${header[2]}`);
      inHeader = true;
      continue;
    }
    if (inHeader) {
      if (line.startsWith('@@') || line.startsWith('Binary files')) {
        inHeader = false;
        out.push(line);
      } else if (/^(new|deleted) file mode|^rename (from|to) |^similarity index/.test(line)) {
        out.push(line);
      }
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}
