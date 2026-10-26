import { promises as fs } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { config } from '../config.js';
import type { AppConfig } from '../apps/apps.js';
import { updateSession } from '../sessions/session-store.js';
import type { SessionRecord } from '../sessions/session.js';
import { docsToUpdate } from '../agents/pre-qa-gate-core.js';
import { appContext } from './app-context.js';
import { neededDocs, queryFromRequirements } from './needed-docs.js';
import { docsMapFingerprint, renderDocsMap, type MapRole } from './docs-map.js';

/** Docs the approved requirements cite (`related-docs`) or ask to change, for the map's first lines. */
export function citedDocs(requirementsRaw: string): string[] {
  const related: unknown = matter(requirementsRaw).data['related-docs'];
  return [...(Array.isArray(related) ? related.map(String) : []), ...docsToUpdate(requirementsRaw)];
}

/** What a stage's docs are chosen for: the requirements when approved, else the session's title and opening message. */
async function queryFor(session: SessionRecord, requirementsRaw: string): Promise<string> {
  if (requirementsRaw) return queryFromRequirements(requirementsRaw);
  const opening = session.transcripts.requirements.find((e) => e.role === 'user')?.text ?? '';
  return `${session.title}. ${opening}`.slice(0, 1200);
}

/** The docs a session needs, ingested (and only those): the requirements' cited docs plus the best search hits for the work. */
export async function contextFor(app: AppConfig, query: string, requirementsRaw = '') {
  return appContext(app, await neededDocs(app, query, citedDocs(requirementsRaw)));
}

/** The map as a system-prompt section, for conversations that always start fresh (team members, reviewers). */
export async function docsMapSection(app: AppConfig, role: MapRole, requirementsRaw = ''): Promise<string> {
  const entries = await contextFor(app, queryFromRequirements(requirementsRaw), requirementsRaw);
  return renderDocsMap(entries, role, citedDocs(requirementsRaw));
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
  const raw = session.requirementsPath
    ? await fs.readFile(path.join(config.harnessRoot, session.requirementsPath), 'utf8').catch(() => '')
    : '';
  const entries = await contextFor(app, await queryFor(session, raw), raw);
  const current = docsMapFingerprint(entries);
  const seen = session.docsMapSeen[role];
  if (!isFirstTurn && seen === current) return { system: '', turnPrefix: '' };

  await updateSession(session.id, { docsMapSeen: { ...session.docsMapSeen, [role]: current } });
  const section = renderDocsMap(entries, role, citedDocs(raw));
  if (isFirstTurn) return { system: options.systemElsewhere ? '' : section, turnPrefix: '' };
  if (!section || (seen === undefined && current === 'none')) return { system: '', turnPrefix: '' };
  return {
    system: '',
    turnPrefix: `# The docs changed since your last turn\n\nThis map replaces the one you were given earlier.${section}\n\n---\n\n`,
  };
}
