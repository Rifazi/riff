import type { FastifyInstance } from 'fastify';
import { listApps, getApp, createApp, updateApp, deleteApp, AppInUseError } from '../apps/apps-store.js';
import { docsDirFor, readRepoUrl, validateRepoRoot, hasDocsDir, InvalidRepoRootError, type CheckCommands } from '../apps/apps.js';
import { buildDocsIndex, watchDocsForChanges, removeIndex } from '../repo/docs-index.js';
import { ROLES, isRole, type Role } from '../settings/settings.js';
import { getPromptOverridesForApp, setPromptOverride } from '../settings/prompts-store.js';
import { readBasePrompt } from '../agents/prompts.js';
import { listIntegrations } from '../repo/integrations.js';
import { assertPathAllowed, PathNotAllowedError } from '../repo/guardrails.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';

async function serializeApp(app: Awaited<ReturnType<typeof getApp>>) {
  return {
    id: app.id,
    name: app.name,
    repoRoot: app.repoRoot,
    checkCommands: app.checkCommands ?? {},
    docsDir: docsDirFor(app),
    repoUrl: readRepoUrl(app),
  };
}

export async function registerAppRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/apps', async () => {
    const apps = await listApps();
    return Promise.all(apps.map(serializeApp));
  });

  // Dry-run only — never touches disk. A missing docs/ is informational,
  // not an error: createApp/updateApp initialize it automatically (see
  // apps.ts's ensureDocsDir), so it's not a reason to block adding the app.
  app.post<{ Body: { repoRoot: string } }>('/api/apps/validate', async (request, reply) => {
    try {
      const resolved = validateRepoRoot(request.body?.repoRoot ?? '');
      return hasDocsDir(resolved)
        ? { ok: true }
        : { ok: true, note: 'No docs/ folder yet — one will be created automatically for this app.' };
    } catch (err) {
      if (err instanceof InvalidRepoRootError) return { ok: false, error: err.message };
      return reply.code(400).send({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post<{ Body: { name: string; repoRoot: string; checkCommands?: CheckCommands } }>('/api/apps', async (request, reply) => {
    const { name, repoRoot, checkCommands } = request.body ?? {};
    if (!name?.trim() || !repoRoot?.trim()) {
      return reply.code(400).send({ error: 'name and repoRoot are required' });
    }
    try {
      const { app: created, docsInitialized } = await createApp({ name, repoRoot, checkCommands });
      await buildDocsIndex(created);
      watchDocsForChanges(created);
      return reply.code(201).send({ ...(await serializeApp(created)), docsInitialized });
    } catch (err) {
      if (err instanceof InvalidRepoRootError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  app.patch<{ Params: { id: string }; Body: { name?: string; repoRoot?: string; checkCommands?: CheckCommands } }>(
    '/api/apps/:id',
    async (request, reply) => {
      try {
        const { app: updated, docsInitialized } = await updateApp(request.params.id, request.body ?? {});
        await buildDocsIndex(updated);
        watchDocsForChanges(updated);
        return { ...(await serializeApp(updated)), docsInitialized };
      } catch (err) {
        if (err instanceof InvalidRepoRootError) return reply.code(400).send({ error: err.message });
        if (err instanceof Error && err.message.includes('not found')) return reply.code(404).send({ error: err.message });
        throw err;
      }
    }
  );

  app.delete<{ Params: { id: string } }>('/api/apps/:id', async (request, reply) => {
    try {
      await deleteApp(request.params.id);
      removeIndex(request.params.id);
      return reply.code(204).send();
    } catch (err) {
      if (err instanceof AppInUseError) return reply.code(409).send({ error: err.message });
      throw err;
    }
  });

  // Returns each role's base (checked-in) prompt alongside this app's
  // current override, if any, so the Apps page can show both — "coordinator"
  // has no prompt file (its base lives in coordinator-agent.ts as an inline
  // constant), so its base comes back as null.
  app.get<{ Params: { id: string } }>('/api/apps/:id/prompts', async (request, reply) => {
    try {
      await getApp(request.params.id);
    } catch {
      return reply.code(404).send({ error: 'app not found' });
    }
    const overrides = await getPromptOverridesForApp(request.params.id);
    const result: Record<Role, { base: string | null; override: string | null }> = {} as never;
    for (const role of ROLES) {
      result[role] = { base: await readBasePrompt(role), override: overrides[role] ?? null };
    }
    return result;
  });

  app.put<{ Params: { id: string; role: string }; Body: { text: string | null } }>(
    '/api/apps/:id/prompts/:role',
    async (request, reply) => {
      if (!isRole(request.params.role)) return reply.code(400).send({ error: `unknown role: ${request.params.role}` });
      try {
        await getApp(request.params.id);
      } catch {
        return reply.code(404).send({ error: 'app not found' });
      }
      await setPromptOverride(request.params.id, request.params.role, request.body?.text ?? null);
      return { ok: true };
    }
  );

  app.get<{ Params: { id: string } }>('/api/apps/:id/integrations', async (request, reply) => {
    try {
      const target = await getApp(request.params.id);
      return listIntegrations(target);
    } catch {
      return reply.code(404).send({ error: 'app not found' });
    }
  });

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>(
    '/api/apps/:id/integrations/doc',
    async (request, reply) => {
      const requestedPath = request.query.path;
      if (!requestedPath) return reply.code(400).send({ error: 'path is required' });
      let target;
      try {
        target = await getApp(request.params.id);
      } catch {
        return reply.code(404).send({ error: 'app not found' });
      }
      try {
        const absolute = assertPathAllowed(requestedPath, ['docs/transmission'], target.repoRoot);
        const markdown = await fs.readFile(absolute, 'utf8');
        return { markdown };
      } catch (err) {
        if (err instanceof PathNotAllowedError) return reply.code(400).send({ error: err.message });
        return reply.code(404).send({ error: `could not read ${requestedPath}` });
      }
    }
  );

  // Customer-EDI-shaped repos generate docs/handbook.html and
  // openapi/api.json via their own build scripts — served as-is, same
  // treatment routes/integrations.ts gave these when there was only one
  // target repo.
  app.get<{ Params: { id: string } }>('/api/apps/:id/docs/handbook', async (request, reply) => {
    let target;
    try {
      target = await getApp(request.params.id);
    } catch {
      return reply.code(404).send({ error: 'app not found' });
    }
    try {
      const html = await fs.readFile(path.join(target.repoRoot, 'docs', 'handbook.html'), 'utf8');
      return reply.type('text/html').send(html);
    } catch {
      return reply
        .code(404)
        .type('text/plain')
        .send('docs/handbook.html not found in this app\'s repo — run its docs-build script there to generate it.');
    }
  });

  app.get<{ Params: { id: string } }>('/api/apps/:id/docs/openapi.json', async (request, reply) => {
    let target;
    try {
      target = await getApp(request.params.id);
    } catch {
      return reply.code(404).send({ error: 'app not found' });
    }
    try {
      const raw = await fs.readFile(path.join(target.repoRoot, 'openapi', 'api.json'), 'utf8');
      return reply.type('application/json').send(raw);
    } catch {
      return reply.code(404).send({
        error: "openapi/api.json not found in this app's repo — run the run_generate_openapi tool, or its equivalent script there, to generate it.",
      });
    }
  });
}
