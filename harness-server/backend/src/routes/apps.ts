import type { FastifyInstance } from 'fastify';
import { createUiuxSession } from '../sessions/uiux-session.js';
import { listApps, getApp, createApp, updateApp, deleteApp, AppInUseError } from '../apps/apps-store.js';
import { docsDirFor, readRepoUrl, validateRepoRoot, describeSetup, baseBranchFor, InvalidRepoRootError, type CheckCommands } from '../apps/apps.js';
import { buildDocsIndex, watchDocsForChanges, removeIndex } from '../repo/docs-index.js';
import { removeAllReferenceDocs } from '../sessions/reference-docs.js';
import { cachedContext, forgetAppContext } from '../context/app-context.js';
import { ROLES, isRole, type Role } from '../settings/settings.js';
import { changeDesignMemory, listDesignMemory } from '../themes/design-memory.js';
import { deleteLesson, listLessons, listRetrospectives, listTrackedSuggestions, setLessonStatus, updateSuggestionStatus } from '../retrospective/store.js';
import { lessonVerdict } from '../retrospective/core.js';
import { suggestionVerdict, type SuggestionStatus } from '../retrospective/suggestion-tracker.js';
import { getPromptOverridesForApp, setPromptOverride } from '../settings/prompts-store.js';
import { readBasePrompt } from '../agents/prompts.js';
import { listIntegrations } from '../repo/integrations.js';
import { assertPathAllowed, PathNotAllowedError } from '../repo/guardrails.js';
import { applyThemePreset, saveAppTheme, summarizeAppTheme, ThemeApplyError, type ThemeApplyResult } from '../themes/apply-theme.js';
import { InvalidArchitectureError, parseArchitectureConfig } from '../architecture/architecture.js';
import { setupArchitecture, type ArchitectureSetupResult } from '../architecture/setup.js';
import { auditWayfinding, formatWayfindingAudit } from '../architecture/wayfinding-audit.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';

async function serializeApp(app: Awaited<ReturnType<typeof getApp>>) {
  return {
    id: app.id,
    name: app.name,
    repoRoot: app.repoRoot,
    baseBranch: baseBranchFor(app),
    checkCommands: app.checkCommands ?? {},
    docsDir: docsDirFor(app),
    repoUrl: readRepoUrl(app),
    theme: summarizeAppTheme(app.repoRoot),
    architecture: app.architecture ?? null,
    uiuxPass: app.uiuxPass === true,
    visualReview: app.visualReview !== false,
  };
}

// Like a theme, the app exists by now, so setup that fails is a warning.
async function runArchitectureSetup(target: Awaited<ReturnType<typeof getApp>>): Promise<ArchitectureSetupResult | undefined> {
  if (!target.architecture) return undefined;
  try {
    return await setupArchitecture(target);
  } catch (err) {
    return { actions: [], warnings: [`Couldn't create the Wayfinding files: ${err instanceof Error ? err.message : String(err)}`] };
  }
}

export async function registerAppRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/apps', async () => {
    const apps = await listApps();
    return Promise.all(apps.map(serializeApp));
  });

  // Dry-run only — never touches disk. A missing folder, docs/ or .git is
  // informational, not an error: createApp/updateApp set those up (see
  // apps.ts's ensureDocsDir and repo/git.ts's setupGitRepo).
  app.post<{ Body: { repoRoot: string } }>('/api/apps/validate', async (request, reply) => {
    try {
      const resolved = validateRepoRoot(request.body?.repoRoot ?? '');
      const note = describeSetup(resolved);
      return note ? { ok: true, note } : { ok: true };
    } catch (err) {
      if (err instanceof InvalidRepoRootError) return { ok: false, error: err.message };
      return reply.code(400).send({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post<{
    Body: {
      name: string;
      repoRoot: string;
      checkCommands?: CheckCommands;
      themeId?: string;
      theme?: unknown;
      basedOn?: string | null;
      architecture?: unknown;
    };
  }>('/api/apps', async (request, reply) => {
    const { name, repoRoot, checkCommands, themeId, theme, basedOn } = request.body ?? {};
    if (!name?.trim() || !repoRoot?.trim()) {
      return reply.code(400).send({ error: 'name and repoRoot are required' });
    }
    try {
      const architecture = parseArchitectureConfig(request.body?.architecture);
      const { app: created, docsInitialized, git } = await createApp({ name, repoRoot, checkCommands, architecture });
      // The app exists by now, so a theme that can't be applied is reported
      // as a warning rather than failing the whole create.
      let themeResult: Omit<ThemeApplyResult, 'theme'> | undefined;
      if (themeId || theme) {
        try {
          themeResult = theme ? await saveAppTheme(created, theme, basedOn ?? null) : await applyThemePreset(created, themeId!);
        } catch (err) {
          if (!(err instanceof ThemeApplyError)) throw err;
          themeResult = { actions: [], warnings: [err.message] };
        }
      }
      const architectureResult = await runArchitectureSetup(created);
      await buildDocsIndex(created);
      watchDocsForChanges(created);
      return reply.code(201).send({ ...(await serializeApp(created)), docsInitialized, git, themeResult, architectureResult });
    } catch (err) {
      if (err instanceof InvalidRepoRootError || err instanceof InvalidArchitectureError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
  });

  app.patch<{
    Params: { id: string };
    Body: { name?: string; repoRoot?: string; checkCommands?: CheckCommands; architecture?: unknown; uiuxPass?: boolean; visualReview?: boolean };
  }>(
    '/api/apps/:id',
    async (request, reply) => {
      try {
        const { architecture: rawArchitecture, ...rest } = request.body ?? {};
        // Absent leaves it as it is; null turns it off.
        const architecture = rawArchitecture === undefined ? undefined : parseArchitectureConfig(rawArchitecture);
        const before = await getApp(request.params.id);
        const { app: updated, docsInitialized, git } = await updateApp(request.params.id, { ...rest, architecture });
        // Setup when it was just turned on or changed (the guide names the
        // folder and interface file), or the app moved to another repo.
        const changed =
          JSON.stringify(before.architecture ?? null) !== JSON.stringify(updated.architecture ?? null) ||
          before.repoRoot !== updated.repoRoot;
        const architectureResult = changed ? await runArchitectureSetup(updated) : undefined;
        await buildDocsIndex(updated);
        watchDocsForChanges(updated);
        return { ...(await serializeApp(updated)), docsInitialized, git, architectureResult };
      } catch (err) {
        if (err instanceof InvalidRepoRootError || err instanceof InvalidArchitectureError) {
          return reply.code(400).send({ error: err.message });
        }
        if (err instanceof Error && err.message.includes('not found')) return reply.code(404).send({ error: err.message });
        throw err;
      }
    }
  );

  // Starts a UI/UX pass: its own session, opened on the Coding tab with its
  // requirements and plan already approved (sessions/uiux-session.ts). Only for
  // apps that turned the pass on.
  app.post<{ Params: { id: string }; Body: { title?: string; focus?: string } }>('/api/apps/:id/uiux-session', async (request, reply) => {
    const target = await getApp(request.params.id).catch(() => null);
    if (!target) return reply.code(404).send({ error: 'app not found' });
    if (!target.uiuxPass) return reply.code(400).send({ error: 'the UI/UX pass is not turned on for this app' });
    const title = request.body?.title?.trim() || 'UI/UX pass';
    const session = await createUiuxSession(target, { title, focus: request.body?.focus });
    return reply.code(201).send(session);
  });

  // What the human asked for about the app's look, remembered across sessions and passes (themes/design-memory.ts).
  app.get<{ Params: { id: string } }>('/api/apps/:id/design-memory', async (request, reply) => {
    if (!(await getApp(request.params.id).catch(() => null))) return reply.code(404).send({ error: 'app not found' });
    return listDesignMemory(request.params.id);
  });

  app.delete<{ Params: { id: string; entryId: string } }>('/api/apps/:id/design-memory/:entryId', async (request, reply) => {
    if (!(await getApp(request.params.id).catch(() => null))) return reply.code(404).send({ error: 'app not found' });
    return changeDesignMemory(request.params.id, null, { remove: [request.params.entryId] });
  });

  // The docs the shared context agent has ingested so far (only ones a session needed), and who wrote each summary.
  app.get<{ Params: { id: string } }>('/api/apps/:id/context', async (request, reply) => {
    if (!(await getApp(request.params.id).catch(() => null))) return reply.code(404).send({ error: 'app not found' });
    return { docs: await cachedContext(request.params.id) };
  });

  // What finished sessions taught, and what goes into every agent's briefing for this app (retrospective/).
  app.get<{ Params: { id: string } }>('/api/apps/:id/lessons', async (request, reply) => {
    if (!(await getApp(request.params.id).catch(() => null))) return reply.code(404).send({ error: 'app not found' });
    return listLessons(request.params.id).map((l) => ({ ...l, verdict: lessonVerdict(l) }));
  });

  app.patch<{ Params: { id: string; lessonId: string }; Body: { status?: string } }>('/api/apps/:id/lessons/:lessonId', async (request, reply) => {
    if (!(await getApp(request.params.id).catch(() => null))) return reply.code(404).send({ error: 'app not found' });
    const status = request.body?.status;
    if (status !== 'active' && status !== 'dismissed') return reply.code(400).send({ error: 'status must be "active" or "dismissed"' });
    return setLessonStatus(request.params.id, request.params.lessonId, status).map((l) => ({ ...l, verdict: lessonVerdict(l) }));
  });

  app.delete<{ Params: { id: string; lessonId: string } }>('/api/apps/:id/lessons/:lessonId', async (request, reply) => {
    if (!(await getApp(request.params.id).catch(() => null))) return reply.code(404).send({ error: 'app not found' });
    return deleteLesson(request.params.id, request.params.lessonId);
  });

  // Bridget's suggestions for the pipeline, with whether acting on them helped (retrospective/suggestion-tracker.ts).
  app.get<{ Params: { id: string } }>('/api/apps/:id/suggestions', async (request, reply) => {
    if (!(await getApp(request.params.id).catch(() => null))) return reply.code(404).send({ error: 'app not found' });
    return listTrackedSuggestions(request.params.id).map((t) => ({ ...t, verdict: suggestionVerdict(t) }));
  });

  app.patch<{ Params: { id: string; key: string }; Body: { status?: string } }>('/api/apps/:id/suggestions/:key', async (request, reply) => {
    if (!(await getApp(request.params.id).catch(() => null))) return reply.code(404).send({ error: 'app not found' });
    const status = request.body?.status as SuggestionStatus | undefined;
    if (!status || !['open', 'done', 'dismissed', 'muted'].includes(status)) return reply.code(400).send({ error: 'status must be open, done, dismissed or muted' });
    return updateSuggestionStatus(request.params.id, request.params.key, status).map((t) => ({ ...t, verdict: suggestionVerdict(t) }));
  });

  app.get<{ Params: { id: string } }>('/api/apps/:id/retrospectives', async (request, reply) => {
    if (!(await getApp(request.params.id).catch(() => null))) return reply.code(404).send({ error: 'app not found' });
    return listRetrospectives(request.params.id);
  });

  app.delete<{ Params: { id: string } }>('/api/apps/:id', async (request, reply) => {
    try {
      await deleteApp(request.params.id);
      removeIndex(request.params.id);
      forgetAppContext(request.params.id);
      await removeAllReferenceDocs({ kind: 'app', appId: request.params.id });
      return reply.code(204).send();
    } catch (err) {
      if (err instanceof AppInUseError) return reply.code(409).send({ error: err.message });
      throw err;
    }
  });

  // The same checks and domain list the agents' audit_architecture tool reports.
  app.get<{ Params: { id: string } }>('/api/apps/:id/architecture/audit', async (request, reply) => {
    let target;
    try {
      target = await getApp(request.params.id);
    } catch {
      return reply.code(404).send({ error: 'app not found' });
    }
    if (!target.architecture) return reply.code(409).send({ error: `${target.name} doesn't follow an architecture.` });
    const audit = auditWayfinding(target.repoRoot, target.architecture);
    return { audit, report: formatWayfindingAudit(audit) };
  });

  // Creates MAP.md / docs/wayfinding.md if they're missing (e.g. setup was
  // skipped because a session branch was checked out).
  app.post<{ Params: { id: string } }>('/api/apps/:id/architecture/setup', async (request, reply) => {
    let target;
    try {
      target = await getApp(request.params.id);
    } catch {
      return reply.code(404).send({ error: 'app not found' });
    }
    if (!target.architecture) return reply.code(409).send({ error: `${target.name} doesn't follow an architecture.` });
    const result = await setupArchitecture(target);
    await buildDocsIndex(target);
    return result;
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
