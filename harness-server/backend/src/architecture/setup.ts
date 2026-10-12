import { existsSync, promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import { baseBranchFor, type AppConfig } from '../apps/apps.js';
import { commitPaths, currentBranch, withRepoLock } from '../repo/git.js';
import { MAP_PATH, WAYFINDING_GUIDE_PATH } from './architecture.js';
import { GUIDE_MARKER, renderMapTemplate, renderWayfindingGuide } from './wayfinding-docs.js';

export interface ArchitectureSetupResult {
  actions: string[];
  warnings: string[];
}

/**
 * Gives an app that opted into Wayfinding its starting files: MAP.md (only
 * if missing; it's the team's to edit from then on) and docs/wayfinding.md
 * (Riff's guide, refreshed when the settings change, never over a
 * hand-written file). Committed on the base branch, like a theme, so every
 * session branch starts with them; on any other branch nothing is written.
 * Domains themselves are never scaffolded: the agents add them as changes
 * need them.
 */
export async function setupArchitecture(app: AppConfig): Promise<ArchitectureSetupResult> {
  const config = app.architecture;
  if (!config) return { actions: [], warnings: [] };

  return withRepoLock(app.repoRoot, async () => {
    const baseBranch = baseBranchFor(app);
    const branch = await currentBranch(app.repoRoot);
    if (branch !== baseBranch) {
      return {
        actions: [],
        warnings: [
          `${app.name} has "${branch}" checked out, so ${MAP_PATH} and ${WAYFINDING_GUIDE_PATH} weren't created. ` +
            `Check out ${baseBranch} and click "Set up files" under Architecture; the agents follow Wayfinding either way.`,
        ],
      };
    }

    const actions: string[] = [];
    const warnings: string[] = [];
    const written: string[] = [];

    const mapFile = path.join(app.repoRoot, MAP_PATH);
    if (!existsSync(mapFile)) {
      await fs.writeFile(mapFile, renderMapTemplate(new Date().toISOString().slice(0, 10)), 'utf8');
      written.push(MAP_PATH);
      actions.push(`Created ${MAP_PATH}, the domain index. It's empty: domains are added as changes need them.`);
    }

    const guideFile = path.join(app.repoRoot, WAYFINDING_GUIDE_PATH);
    const guide = renderWayfindingGuide(config);
    let existing: string | null = null;
    try {
      existing = readFileSync(guideFile, 'utf8');
    } catch {
      // not there yet
    }
    if (existing !== null && !existing.startsWith(GUIDE_MARKER)) {
      warnings.push(`${WAYFINDING_GUIDE_PATH} already exists and wasn't written by Riff, so it was left alone.`);
    } else if (existing !== guide) {
      await fs.mkdir(path.dirname(guideFile), { recursive: true });
      await fs.writeFile(guideFile, guide, 'utf8');
      written.push(WAYFINDING_GUIDE_PATH);
      actions.push(`${existing === null ? 'Wrote' : 'Updated'} ${WAYFINDING_GUIDE_PATH}, the procedure the agents and your team follow.`);
    }

    if (!written.length) return { actions: ['Wayfinding files are already in place.'], warnings };
    // A first setup writes MAP.md; later ones only refresh the guide.
    const message = written.includes(MAP_PATH) ? 'docs: adopt Wayfinding Architecture' : 'docs: update the Wayfinding guide';
    const commit = await commitPaths(app.repoRoot, written, message);
    if (commit === 'committed') actions.push(`Committed them on ${baseBranch}.`);
    if (commit === 'no-identity') {
      warnings.push(`Git has no user.name/user.email configured, so they weren't committed. Commit them on ${baseBranch} before starting a coding stage.`);
    }
    return { actions, warnings };
  });
}
