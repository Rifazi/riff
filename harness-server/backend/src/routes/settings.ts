import type { FastifyInstance } from 'fastify';
import { getSettings, updateSettings, type SettingsPatch } from '../settings/settings-store.js';
import {
  isClassificationModel,
  isProvider,
  isRole,
  redactSettings,
  type JiraSettings,
  type RoleModelConfig,
} from '../settings/settings.js';
import { listOllamaModels, testOllama } from '../settings/ollama.js';
import { testClaudeLogin, testProviderCredential } from '../agents/sdk-client.js';
import { classificationCacheStatus, clearClassificationCache } from '../agents/helpers/classifier/classifier.js';
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
    if (body.ollamaEndpoint !== undefined && typeof body.ollamaEndpoint !== 'string') {
      return reply.code(400).send({ error: 'ollamaEndpoint must be a string' });
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
        if (roleModelConfig?.lightModel !== undefined && typeof roleModelConfig.lightModel !== 'string') {
          return reply.code(400).send({ error: 'lightModel must be a string' });
        }
        if (roleModelConfig?.useLocalModel !== undefined && typeof roleModelConfig.useLocalModel !== 'boolean') {
          return reply.code(400).send({ error: 'useLocalModel must be a boolean' });
        }
        if (roleModelConfig?.localTeamModel !== undefined && typeof roleModelConfig.localTeamModel !== 'string') {
          return reply.code(400).send({ error: 'localTeamModel must be a string' });
        }
        if (roleModelConfig?.delegateModel !== undefined && typeof roleModelConfig.delegateModel !== 'string') {
          return reply.code(400).send({ error: 'delegateModel must be a string' });
        }
      }
    }
    if (body.classification?.model !== undefined) {
      const model = body.classification.model;
      if (typeof model !== 'string' || !isClassificationModel(model)) {
        return reply.code(400).send({ error: `unknown classification model: ${String(model)}` });
      }
    }
    const updated = await updateSettings(body);
    return redactSettings(updated);
  });

  // What the Settings → Dev Agents model pickers suggest for the "ollama"
  // provider: whatever is installed on this machine, with tool support
  // flagged (the agent roles are tool-calling loops). Failing to reach the
  // server is not an error here — the UI shows an empty list and Test's
  // failure message explains why.
  app.get('/api/settings/ollama/models', async () => {
    try {
      return { models: await listOllamaModels() };
    } catch (err) {
      return { models: [], error: err instanceof Error ? err.message : String(err) };
    }
  });

  app.post<{ Body: { provider: string; apiKey?: string; model?: string; endpoint?: string } }>(
    '/api/settings/test',
    async (request, reply) => {
      const { provider, apiKey, model, endpoint } = request.body ?? {};
      if (!provider || !isProvider(provider)) {
        return reply.code(400).send({ ok: false, error: 'unknown provider' });
      }

      if (provider === 'claude') {
        try {
          await testClaudeLogin();
          return { ok: true };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }

      // Ollama takes no key: the test is reachability plus (when one is
      // given) the model being installed and tools-capable. `endpoint` is
      // the form's unsaved value — same test-before-save as the rest.
      if (provider === 'ollama') {
        try {
          const models = await testOllama(model, typeof endpoint === 'string' ? endpoint : undefined);
          return { ok: true, models };
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
    },
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

  // Cache status for the on-device classification models. Read fresh off disk
  // on every request (same as the local-model status) so Settings reflects a
  // download that finished, or a cache someone cleared, without a restart.
  app.get('/api/settings/classification-cache', async (_request, reply) => {
    try {
      return { models: await classificationCacheStatus() };
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Wipes every cached classification model, not just the selected one — the
  // next classify_text call re-downloads whichever model is selected then.
  app.post('/api/settings/classification-cache/clear', async (_request, reply) => {
    try {
      await clearClassificationCache();
      return { ok: true };
    } catch (err) {
      return reply.code(500).send({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
}
