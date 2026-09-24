import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config } from './config.js';
import { listApps } from './apps/apps-store.js';
import { buildDocsIndex, watchDocsForChanges } from './repo/docs-index.js';
import { registerSessionRoutes } from './routes/sessions.js';
import { registerRequirementsRoutes } from './routes/requirements.js';
import { registerPlanRoutes } from './routes/plan.js';
import { registerCodingRoutes } from './routes/coding.js';
import { registerQaRoutes } from './routes/qa.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerAppRoutes } from './routes/apps.js';
import { registerCoordinatorRoutes } from './routes/coordinator.js';

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

  await registerSessionRoutes(app);
  await registerRequirementsRoutes(app);
  await registerPlanRoutes(app);
  await registerCodingRoutes(app);
  await registerQaRoutes(app);
  await registerSettingsRoutes(app);
  await registerAppRoutes(app);
  await registerCoordinatorRoutes(app);

  app.get('/api/health', async () => ({ ok: true }));

  await app.listen({ port: config.port, host: '127.0.0.1' });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Harness backend failed to start:', err);
  process.exit(1);
});
