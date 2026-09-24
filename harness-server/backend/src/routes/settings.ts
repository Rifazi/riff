import type { FastifyInstance } from 'fastify';
import { getSettings, updateSettings, type SettingsPatch } from '../settings/settings-store.js';
import { isProvider, isRole, providerNeedsApiKey, redactSettings, type JiraSettings, type RoleModelConfig } from '../settings/settings.js';
import { testClaudeLogin, testProviderCredential } from '../agents/sdk-client.js';
import { testJiraConnection } from '../jira/jira-client.js';

export async function registerSettingsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/settings', async () => {
    const settings = await getSettings();
    return redactSettings(settings);
  });

  app.post<{ Body: SettingsPatch }>('/api/settings', async (request, reply) => {
    const body = request.body ?? {};
    if (body.credentials) {
      for (const key of Object.keys(body.credentials)) {
        if (!isProvider(key)) return reply.code(400).send({ error: `unknown provider: ${key}` });
      }
    }
    if (body.models) {
      for (const [role, cfg] of Object.entries(body.models)) {
        if (!isRole(role)) {
          return reply.code(400).send({ error: `unknown role: ${role}` });
        }
        const roleModelConfig = cfg as RoleModelConfig | undefined;
        if (roleModelConfig && !isProvider(roleModelConfig.provider)) {
          return reply.code(400).send({ error: `unknown provider: ${roleModelConfig.provider}` });
        }
      }
    }
    const updated = await updateSettings(body);
    return redactSettings(updated);
  });

  app.post<{ Body: { provider: string; apiKey?: string; model?: string } }>(
    '/api/settings/test',
    async (request, reply) => {
      const { provider, apiKey, model } = request.body ?? {};
      if (!provider || !isProvider(provider)) {
        return reply.code(400).send({ ok: false, error: 'unknown provider' });
      }

      if (!providerNeedsApiKey(provider)) {
        try {
          await testClaudeLogin();
          return { ok: true };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }

      let key = apiKey?.trim();
      if (!key) {
        const settings = await getSettings();
        key = settings.credentials[provider];
      }
      if (!key) {
        return reply.code(400).send({ ok: false, error: 'no API key provided or saved for this provider' });
      }
      try {
        await testProviderCredential(provider, key, model);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  );

  // Tests against whatever's already saved, overlaid with any unsaved
  // in-progress edits from the form — same "test before you save" pattern
  // as /api/settings/test above.
  app.post<{ Body: Partial<JiraSettings> }>('/api/settings/jira/test', async (request, reply) => {
    const settings = await getSettings();
    const body = request.body ?? {};
    const candidate: JiraSettings = {
      ...settings.jira,
      ...body,
      // An empty/omitted apiToken in the request means "use the saved one",
      // same as the API-key test endpoint above — an explicit blank string
      // shouldn't silently break a test against an already-saved token.
      apiToken: body.apiToken?.trim() || settings.jira.apiToken,
    };
    try {
      await testJiraConnection(candidate);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
