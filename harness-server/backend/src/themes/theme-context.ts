import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { updateSession } from '../sessions/session-store.js';
import type { SessionRecord } from '../sessions/session.js';
import { summarizeAppTheme } from './apply-theme.js';
import { THEME_DEFINITION_PATH, themeBriefing, type ThemeBriefingRole } from './theme-docs.js';

// Identifies the theme an agent was last briefed on; changes whenever
// theme.json does (a new pick, an edit, or a hand edit).
function themeFingerprint(repoRoot: string): { name: string | null; fingerprint: string } {
  const summary = summarizeAppTheme(repoRoot);
  if (!summary) return { name: null, fingerprint: 'none' };
  let raw = '';
  try {
    raw = readFileSync(path.join(repoRoot, THEME_DEFINITION_PATH), 'utf8');
  } catch {
    // summarizeAppTheme just read it; a race here only means a re-brief next turn
  }
  return { name: summary.name, fingerprint: createHash('sha1').update(raw).digest('hex').slice(0, 12) };
}

/**
 * The theme briefing for one plan/coding/QA turn. On a stage's first turn
 * it goes in the system prompt. After that, a resumed Claude session never
 * re-reads its system prompt, so if the theme changed since this stage was
 * last briefed (or the session predates theme briefings), it travels in
 * the turn prompt instead, the same way the reconciliation context does.
 */
export async function themeContextForTurn(
  session: SessionRecord,
  role: ThemeBriefingRole,
  repoRoot: string,
  isFirstTurn: boolean
): Promise<{ system: string; turnPrefix: string }> {
  const { name, fingerprint } = themeFingerprint(repoRoot);
  const seen = session.themeContextSeen[role];
  if (!isFirstTurn && seen === fingerprint) return { system: '', turnPrefix: '' };

  const briefing = themeBriefing(role, name);
  await updateSession(session.id, { themeContextSeen: { ...session.themeContextSeen, [role]: fingerprint } });
  if (isFirstTurn) return { system: briefing, turnPrefix: '' };
  if (!briefing.trim()) return { system: '', turnPrefix: '' };
  const heading =
    seen === undefined
      ? '# UI theme context for this app'
      : "# The app's UI theme changed since your last turn\n\nWhat follows replaces anything you were told earlier about the theme.";
  return { system: '', turnPrefix: `${heading}${briefing}\n\n---\n\n` };
}

/** For a coding-team member, which always starts a fresh conversation. */
export function themeBriefingFor(repoRoot: string, role: ThemeBriefingRole): string {
  return themeBriefing(role, themeFingerprint(repoRoot).name);
}
