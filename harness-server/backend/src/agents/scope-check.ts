const CODE_FILE = /\.(?:[cm]?[jt]sx?|css|scss|py|rs|go|java|json|ya?ml)$/i;
const IGNORED = /(?:^|\/)(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|tsconfig[^/]*\.json)$|\.(?:test|spec)\.|(?:^|\/)(?:__tests__|fixtures|node_modules|theme)\//i;

const GENERIC_FOLDERS = new Set(['src', 'lib', 'app', 'apps', 'packages', 'client', 'server', 'shared', 'source', 'test', 'tests', 'docs']);

const dirOf = (file: string) => file.split('/').slice(0, -1).join('/');

/** Whether the plan or requirements name this file's path, a folder above it, or the name of its own folder. */
function mentioned(file: string, text: string): boolean {
  const lower = text.toLowerCase();
  const path = file.toLowerCase();
  if (lower.includes(path)) return true;
  const parts = path.split('/');
  for (let i = parts.length - 1; i >= 1; i--) {
    if (!GENERIC_FOLDERS.has(parts[i - 1]) && lower.includes(parts.slice(0, i).join('/'))) return true;
  }
  const folder = parts[parts.length - 2];
  return Boolean(folder && folder.length >= 4 && !GENERIC_FOLDERS.has(folder) && lower.includes(folder));
}

export interface ScopeFinding {
  newDomains: string[];
  folders: string[];
}

/**
 * Work the branch did that neither the approved requirements nor the plan
 * mention: a new README.md in a folder they never name (a new domain), and
 * folders of code changed that they never name. Docs, tests, lockfiles and
 * theme files are ignored. Folders are only reported when there are 3 or
 * more, since a plan names folders loosely; a new domain is always reported.
 */
export function outOfPlan(changed: readonly string[], added: readonly string[], planText: string): ScopeFinding | null {
  const newDomains = [
    ...new Set(
      added
        .filter((f) => /(?:^|\/)README\.md$/.test(f) && dirOf(f) !== '' && !/^(?:docs|\.github)(?:\/|$)/.test(f))
        .map(dirOf)
        .filter((dir) => !mentioned(`${dir}/x`, planText)),
    ),
  ];
  const folders = [
    ...new Set(
      changed
        .filter((f) => CODE_FILE.test(f) && !IGNORED.test(f) && dirOf(f) !== '' && !mentioned(f, planText))
        .map(dirOf)
        .filter((dir) => !newDomains.includes(dir)),
    ),
  ];
  const shownFolders = folders.length >= 3 ? folders : [];
  return newDomains.length || shownFolders.length ? { newDomains, folders: shownFolders } : null;
}

export function scopeCheckOutput(f: ScopeFinding): string {
  const lines = [
    ...f.newDomains.map((d) => `- ${d}/ is a new domain (it has a new README.md), but neither the requirements nor the plan mention it`),
    ...f.folders.slice(0, 10).map((d) => `- ${d}/ has changed code, but neither the requirements nor the plan mention that folder`),
  ];
  if (f.folders.length > 10) lines.push(`- … ${f.folders.length - 10} more folders`);
  return (
    `${lines.join('\n')}\n\nThis ticket is scoped by its requirements and plan. Revert what is out of scope, or, if it is needed, ` +
    'say why with note_for_qa so QA can judge it; do not leave it half-done (a moved or new domain needs its docs fixed in the same commit).'
  );
}
