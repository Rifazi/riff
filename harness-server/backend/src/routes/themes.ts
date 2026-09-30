import type { FastifyInstance } from 'fastify';
import { getApp } from '../apps/apps-store.js';
import { getSession, updateSession } from '../sessions/session-store.js';
import { presetDefinition, THEME_PRESETS } from '../themes/presets.js';
import { previewComponentsCss, tokenMaps } from '../themes/theme-css.js';
import { InvalidThemeError, parseThemeDefinition } from '../themes/theme-schema.js';
import { auditThemeUsage } from '../themes/theme-audit.js';
import {
  applyThemePreset,
  readAppTheme,
  regenerateAppTheme,
  saveAppTheme,
  ThemeApplyError,
  type ThemeApplyResult,
} from '../themes/apply-theme.js';

// Neither the presets nor the component rules change at runtime.
const PRESETS = THEME_PRESETS.map((preset) => ({ id: preset.id, theme: presetDefinition(preset), tokens: tokenMaps(preset) }));
const COMPONENTS_CSS = previewComponentsCss();

type ThemeBody = { theme?: unknown; basedOn?: string | null; themeId?: string };

export async function registerThemeRoutes(app: FastifyInstance): Promise<void> {
  // The component CSS is the same stylesheet a saved theme writes to the
  // repo, scoped to [data-ui-theme] wrappers; each wrapper gets its tokens
  // inline from these maps (or /api/themes/preview for unsaved edits).
  app.get('/api/themes', async () => ({ presets: PRESETS, componentsCss: COMPONENTS_CSS }));

  app.post<{ Body: { theme: unknown } }>('/api/themes/preview', async (request, reply) => {
    try {
      return { tokens: tokenMaps(parseThemeDefinition(request.body?.theme)) };
    } catch (err) {
      if (err instanceof InvalidThemeError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  app.get<{ Params: { id: string } }>('/api/apps/:id/theme', async (request, reply) => {
    let target;
    try {
      target = await getApp(request.params.id);
    } catch {
      return reply.code(404).send({ error: 'app not found' });
    }
    try {
      const current = readAppTheme(target.repoRoot);
      return { current: current && { ...current, tokens: tokenMaps(current.theme) }, error: null };
    } catch (err) {
      if (err instanceof InvalidThemeError) return { current: null, error: err.message };
      throw err;
    }
  });

  // { themeId } applies a preset as-is; { theme, basedOn } saves an edited one.
  app.put<{ Params: { id: string }; Body: ThemeBody }>('/api/apps/:id/theme', async (request, reply) => {
    const { theme, basedOn, themeId } = request.body ?? {};
    if (!theme && !themeId) return reply.code(400).send({ error: 'theme or themeId is required' });
    return withApp(request.params.id, reply, (target) =>
      theme ? saveAppTheme(target, theme, basedOn ?? null) : applyThemePreset(target, themeId!)
    );
  });

  // The same audit the agents' audit_theme tool reports, for the Theme page.
  app.get<{ Params: { id: string } }>('/api/apps/:id/theme/audit', async (request, reply) => {
    try {
      return await auditThemeUsage((await getApp(request.params.id)).repoRoot);
    } catch {
      return reply.code(404).send({ error: 'app not found' });
    }
  });

  app.post<{ Params: { id: string } }>('/api/apps/:id/theme/regenerate', async (request, reply) =>
    withApp(request.params.id, reply, regenerateAppTheme)
  );

  // Human-only, like accepting a split: apply the requirements agent's
  // suggestion, as proposed or as edited in the picker. The UI follows up
  // with a chat message so the agent knows what happened.
  app.post<{ Params: { id: string }; Body: ThemeBody }>('/api/sessions/:id/theme-proposal/apply', async (request, reply) => {
    const session = await getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: 'session not found' });
    if (!session.themeProposal) return reply.code(409).send({ error: 'This session has no theme proposal to apply.' });
    const theme = request.body?.theme ?? session.themeProposal.theme;
    const basedOn = request.body?.theme ? (request.body.basedOn ?? null) : session.themeProposal.basedOn;
    return withApp(session.appId, reply, async (target) => {
      const result = await saveAppTheme(target, theme, basedOn);
      await updateSession(session.id, { themeProposal: null });
      return result;
    });
  });

  app.post<{ Params: { id: string } }>('/api/sessions/:id/theme-proposal/dismiss', async (request, reply) => {
    const session = await getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: 'session not found' });
    return updateSession(session.id, { themeProposal: null });
  });
}

async function withApp(
  appId: string,
  reply: { code: (n: number) => { send: (body: unknown) => unknown } },
  fn: (target: Awaited<ReturnType<typeof getApp>>) => Promise<ThemeApplyResult>
) {
  let target;
  try {
    target = await getApp(appId);
  } catch {
    return reply.code(404).send({ error: 'app not found' });
  }
  try {
    return await fn(target);
  } catch (err) {
    if (err instanceof ThemeApplyError) return reply.code(409).send({ error: err.message });
    throw err;
  }
}
