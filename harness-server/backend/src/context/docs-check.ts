import type { AppConfig } from '../apps/apps.js';
import { docsToUpdate, untouchedDocs } from '../agents/pre-qa-gate-core.js';
import { diffBaseFor } from '../sessions/shared-branch.js';
import type { SessionRecord } from '../sessions/session.js';
import { branchChanges } from '../repo/git.js';

/**
 * What QA is told about the requirements' "Docs to update": which listed docs
 * the branch changed and which it left alone, computed from the diff so QA
 * doesn't spend requests establishing it. '' when the requirements list none.
 */
export function docsCheckNote(requirementsRaw: string, changedFiles: readonly string[]): string {
  const listed = docsToUpdate(requirementsRaw);
  if (listed.length === 0) return '';
  const untouched = untouchedDocs(listed, changedFiles);
  const touched = listed.filter((d) => !untouched.includes(d));
  const lines = ['\n\n# Docs check (computed from the branch diff)'];
  if (touched.length > 0) lines.push(`Changed on this branch: ${touched.join(', ')}. Don't check that they were touched; judge whether what they say is right and complete.`);
  if (untouched.length > 0) {
    lines.push(
      `Listed but not changed: ${untouched.join(', ')}. The coder may have explained why (see the QA notes); ` +
        'report it only if the requirements really needed a change there.'
    );
  }
  return lines.join('\n');
}

/** `docsCheckNote` for a session's branch; '' when the requirements list no docs or the diff can't be read. */
export async function docsCheckNoteForBranch(session: SessionRecord, app: AppConfig, requirementsRaw: string): Promise<string> {
  if (!session.branch || docsToUpdate(requirementsRaw).length === 0) return '';
  const changes = await branchChanges(app.repoRoot, diffBaseFor(session, app), ':(glob)**/*.md', session.branch);
  return changes ? docsCheckNote(requirementsRaw, changes.files) : '';
}
