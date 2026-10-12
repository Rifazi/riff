import type { AppConfig } from '../apps/apps.js';
import { updateSession } from '../sessions/session-store.js';
import type { SessionRecord } from '../sessions/session.js';
import { wayfindingBriefing, type ArchitectureBriefingRole } from './wayfinding-docs.js';

const fingerprint = (app: AppConfig) => (app.architecture ? JSON.stringify(app.architecture) : 'none');

// A base prompt's general guidance on finding code and keeping a code map
// sits in blocks with a second version for apps that follow an architecture:
//   <!-- nav -->general text<!-- nav: wayfinding -->architecture text<!-- /nav -->
const NAV_BLOCK = /<!-- nav -->\n?([\s\S]*?)<!-- nav: wayfinding -->\n?([\s\S]*?)<!-- \/nav -->\n?/g;

/** A base prompt (or override, which has no blocks) with the navigation guidance that fits the app. */
export function promptForArchitecture(prompt: string, app: Pick<AppConfig, 'architecture'> | null): string {
  return prompt.replace(NAV_BLOCK, (_match, general: string, wayfinding: string) => (app?.architecture ? wayfinding : general));
}

/** The architecture section of a role's system prompt; '' for an app without one. */
export function architectureBriefingFor(app: AppConfig, role: ArchitectureBriefingRole): string {
  return app.architecture ? wayfindingBriefing(role, app.architecture) : '';
}

/**
 * Same delivery as the theme briefing (themes/theme-context.ts): in the
 * system prompt on a stage's first turn, and in the turn prompt when the
 * app's architecture setting changed since the stage was last briefed,
 * since a resumed Claude session never re-reads its system prompt.
 */
export async function architectureContextForTurn(
  session: SessionRecord,
  role: ArchitectureBriefingRole,
  app: AppConfig,
  isFirstTurn: boolean
): Promise<{ system: string; turnPrefix: string }> {
  const current = fingerprint(app);
  const seen = session.architectureContextSeen[role];
  if (!isFirstTurn && seen === current) return { system: '', turnPrefix: '' };

  await updateSession(session.id, { architectureContextSeen: { ...session.architectureContextSeen, [role]: current } });
  const briefing = architectureBriefingFor(app, role);
  if (isFirstTurn) return { system: briefing, turnPrefix: '' };
  // A session that predates this setting, on an app without one: nothing to say.
  if (seen === undefined && current === 'none') return { system: '', turnPrefix: '' };
  if (!briefing) {
    return {
      system: '',
      turnPrefix:
        "# This app no longer follows an architecture\n\nIgnore what you were told earlier about Wayfinding Architecture; " +
        'audit_architecture is gone.\n\n---\n\n',
    };
  }
  const heading =
    seen === undefined || seen === 'none'
      ? '# This app now follows Wayfinding Architecture'
      : "# The app's architecture settings changed\n\nWhat follows replaces anything you were told earlier about them.";
  return { system: '', turnPrefix: `${heading}${briefing}\n\n---\n\n` };
}
