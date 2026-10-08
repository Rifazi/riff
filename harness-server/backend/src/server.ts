import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config } from './config.js';
import { listApps } from './apps/apps-store.js';
import { buildDocsIndex, stopAllWatching, watchDocsForChanges } from './repo/docs-index.js';
import { stopSearchEngine } from './search/search-engine.js';
import { registerSessionRoutes } from './routes/sessions.js';
import { registerRequirementsRoutes } from './routes/requirements.js';
import { registerPlanRoutes } from './routes/plan.js';
import { registerCodingRoutes } from './routes/coding.js';
import { registerQaRoutes } from './routes/qa.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerAppRoutes } from './routes/apps.js';
import { registerCoordinatorRoutes } from './routes/coordinator.js';
import { registerThemeRoutes } from './routes/themes.js';
import { registerReferenceDocRoutes } from './routes/reference-docs.js';
import { registerUsageRoutes } from './routes/usage.js';
import { recoverInterruptedTeams } from './agents/team/coding-team.js';
import { recoverInterruptedQaTeams } from './agents/team/qa-team.js';
import { stopLocalModel } from './agents/local-llm.js';

// How long in-flight requests (e.g. a streaming agent turn) get to finish on
// shutdown before the process exits anyway. Riff kills it at 5s.
const SHUTDOWN_GRACE_MS = 3000;

async function main() {
  // Default is 1MB — raised so a chat message can carry a base64-encoded
  // PDF attachment (base64 adds ~33% overhead on top of the 15MB per-file
  // cap enforced in agents/attachments.ts).
  const app = Fastify({ logger: true, bodyLimit: 25 * 1024 * 1024 });

  await app.register(cors, { origin: config.allowedOrigins });

  // CORS only stops a foreign page from reading responses; a body-less
  // cross-site POST (e.g. .../approve) still executes. Browsers always send
  // Origin on cross-origin requests, so reject unknown ones outright.
  // Requests with no Origin (curl, the CLI) are same-machine and allowed.
  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin;
    if (origin && !config.allowedOrigins.includes(origin)) {
      return reply.code(403).send({ error: `origin not allowed: ${origin}` });
    }
  });

  // Error bodies aren't in Fastify's default request log; without this a
  // 4xx the UI swallowed leaves no trace of why it happened.
  app.addHook('onSend', async (request, reply, payload) => {
    if (reply.statusCode >= 400 && typeof payload === 'string') {
      request.log.warn({ statusCode: reply.statusCode, body: payload.slice(0, 500) }, 'request failed');
    }
    return payload;
  });

  for (const target of await listApps()) {
    await buildDocsIndex(target);
    watchDocsForChanges(target);
  }

  await recoverInterruptedTeams();
  await recoverInterruptedQaTeams();
  await registerSessionRoutes(app);
  await registerRequirementsRoutes(app);
  await registerPlanRoutes(app);
  await registerCodingRoutes(app);
  await registerQaRoutes(app);
  await registerSettingsRoutes(app);
  await registerAppRoutes(app);
  await registerCoordinatorRoutes(app);
  await registerThemeRoutes(app);
  await registerReferenceDocRoutes(app);
  await registerUsageRoutes(app);

  app.get('/api/health', async () => ({ ok: true }));

  // Riff stops this server with SIGTERM, and passes a pipe as stdin that
  // closes when Riff exits for any reason, so a crashed app can't leave the
  // server (and the port) behind. Ctrl+C covers `npm run dev`.
  let shuttingDown = false;
  const shutdown = (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ reason }, 'shutting down');
    const force = setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS);
    force.unref();
    stopLocalModel();
    stopSearchEngine();
    Promise.allSettled([app.close(), stopAllWatching()]).finally(() => process.exit(0));
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGHUP', () => shutdown('SIGHUP'));
  if (process.env.HARNESS_EXIT_ON_STDIN_CLOSE === '1') {
    process.stdin.on('end', () => shutdown('parent closed stdin'));
    process.stdin.on('error', () => shutdown('parent stdin error'));
    process.stdin.resume();
  }

  await app.listen({ port: config.port, host: '127.0.0.1' });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Harness backend failed to start:', err);
  process.exit(1);
});
