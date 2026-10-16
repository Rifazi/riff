import { readFileSync } from 'node:fs';
import path from 'node:path';
import { exportedNames } from '../architecture/wayfinding-audit.js';

const CODE_FILE = /\.(?:[cm]?[jt]sx?)$/;

/**
 * `- path (N lines): exports` for each file, so an agent knows what a file
 * holds without reading it: a fresh conversation's own writes (a restarted
 * engineer re-read every file it had written, session a58b69ad), and the
 * research helper's "what does each file under X do".
 */
export function describeFiles(repoRoot: string, files: string[], max = 20): string[] {
  return files
    .slice(0, max)
    .map((file) => {
      let source: string;
      try {
        source = readFileSync(path.join(repoRoot, file), 'utf8');
      } catch {
        return `- ${file}`;
      }
      const lines = source.split('\n').length;
      const names = CODE_FILE.test(file) ? exportedNames(source) : [];
      return `- ${file} (${lines} lines)${names.length ? `: ${names.slice(0, 10).join(', ')}${names.length > 10 ? ', …' : ''}` : ''}`;
    })
    .concat(files.length > max ? [`- … ${files.length - max} more`] : []);
}
