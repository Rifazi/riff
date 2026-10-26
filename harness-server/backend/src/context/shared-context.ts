import { promises as fs } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { config } from '../config.js';
import type { AppConfig } from '../apps/apps.js';
import { updateSession } from '../sessions/session-store.js';
import type { SessionRecord } from '../sessions/session.js';
import { docsToUpdate } from '../agents/pre-qa-gate-core.js';
import { appContext } from './app-context.js';
import { docsMapFingerprint, renderDocsMap, type MapRole } from './docs-map.js';

/** Docs the approved requirements cite (`related-docs`) or ask to change, for the map's first lines. */
export function citedDocs(requirementsRaw: string): string[] {
  const related: unknown = matter(requirementsRaw).data['related-docs'];
  return [...(Array.isArray(related) ? related.map(String) : []), ...docsToUpdate(requirementsRaw)];
}

async function citedFor(session: SessionRecord): Promise<string[]> {
  if (!session.requirementsPath) return [];
  const raw = await fs.readFile(path.join(config.harnessRoot, session.requirementsPath), 'utf8').catch(() => '');
  return citedDocs(raw);
}

/** The map as a system-prompt section, for conversations that always start fresh (team members, reviewers). */
export async function docsMapSection(app: AppConfig, role: MapRole, requirementsRaw = ''): Promise<string> {
  return renderDocsMap(await appContext(app), role, citedDocs(requirementsRaw));
}

/**
 * Same delivery as the theme and architecture briefings: in the system prompt
 * on a stage's first turn, in the turn prompt when a doc was added, removed
 * or edited since the stage last saw the map (a resumed Claude session never
 * re-reads its system prompt). `systemElsewhere` is for a stage whose first-turn
 * sections already include the map: it only reports changes after that.
 */
export async function sharedContextForTurn(
  session: SessionRecord,
  role: MapRole,
  app: AppConfig,
  isFirstTurn: boolean,
  options: { systemElsewhere?: boolean } = {}
): Promise<{ system: string; turnPrefix: string }> {
  const entries = await appContext(app);
  const current = docsMapFingerprint(entries);
  const seen = session.docsMapSeen[role];
  if (!isFirstTurn && seen === current) return { system: '', turnPrefix: '' };

  await updateSession(session.id, { docsMapSeen: { ...session.docsMapSeen, [role]: current } });
  const section = renderDocsMap(entries, role, await citedFor(session));
  if (isFirstTurn) return { system: options.systemElsewhere ? '' : section, turnPrefix: '' };
  if (!section || (seen === undefined && current === 'none')) return { system: '', turnPrefix: '' };
  return {
    system: '',
    turnPrefix: `# The docs changed since your last turn\n\nThis map replaces the one you were given earlier.${section}\n\n---\n\n`,
  };
}
