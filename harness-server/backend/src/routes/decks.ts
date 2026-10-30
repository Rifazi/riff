import type { FastifyInstance, FastifyReply } from 'fastify';
import { promises as fs } from 'node:fs';
import { z } from 'zod';
import { LENGTHS } from '../decks/deck-spec.js';
import { deleteDeck, deckFilePath, listJobs, loadJob } from '../decks/deck-store.js';
import { DeckError, deckWithSlides, deleteDeckSlide, recreateDeckSlide, restyleDeck, startDeck } from '../decks/deck-service.js';

const modeSchema = z.enum(['light', 'dark']);

const createSchema = z.object({
  title: z.string().trim().min(1).max(200),
  sourceId: z.string().trim().min(1).max(100),
  notes: z.string().trim().min(1),
  overview: z.string().nullish(),
  covers: z.string().max(200).optional(),
  audience: z.string().trim().max(200).default(''),
  length: z.enum(LENGTHS).default('standard'),
  speakerNotes: z.boolean().default(true),
  focus: z.string().trim().max(1000).optional(),
  themeId: z.string().max(100).optional(),
  mode: modeSchema.optional(),
});

const recreateSchema = z.object({ instruction: z.string().trim().max(1000).default('') });
const restyleSchema = z.object({ themeId: z.string().min(1).max(100), mode: modeSchema });

// Service errors carry their own status; anything else is a 500 with its message.
async function respond<T>(reply: FastifyReply, work: () => Promise<T>) {
  try {
    return await work();
  } catch (err) {
    const status = err instanceof DeckError ? err.status : 500;
    return reply.code(status).send({ error: err instanceof Error ? err.message : String(err) });
  }
}

const badBody = (reply: FastifyReply, error: z.ZodError) =>
  reply.code(400).send({ error: error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });

export async function registerDeckRoutes(app: FastifyInstance) {
  // Starts a deck from a journal; the UI polls GET /api/decks/:id.
  app.post('/api/decks', async (request, reply) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) return badBody(reply, parsed.error);
    return reply.code(202).send(await startDeck(parsed.data));
  });

  // The decks made from one journal, newest first.
  app.get<{ Querystring: { sourceId?: string } }>('/api/decks', async (request, reply) => {
    if (!request.query.sourceId) return reply.code(400).send({ error: 'sourceId is required.' });
    return listJobs(request.query.sourceId);
  });

  app.get<{ Params: { id: string } }>('/api/decks/:id', async (request, reply) => {
    return (await loadJob(request.params.id)) ?? reply.code(404).send({ error: 'Presentation not found.' });
  });

  // The slides and the theme colors to draw them in, for the editor.
  app.get<{ Params: { id: string } }>('/api/decks/:id/slides', (request, reply) =>
    respond(reply, () => deckWithSlides(request.params.id)),
  );

  app.delete<{ Params: { id: string } }>('/api/decks/:id', async (request, reply) => {
    if (!(await deleteDeck(request.params.id))) return reply.code(404).send({ error: 'Presentation not found.' });
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string; index: string } }>('/api/decks/:id/slides/:index/recreate', (request, reply) =>
    respond(reply, async () => {
      const parsed = recreateSchema.safeParse(request.body ?? {});
      if (!parsed.success) return badBody(reply, parsed.error);
      await recreateDeckSlide(request.params.id, Number(request.params.index), parsed.data.instruction);
      return deckWithSlides(request.params.id);
    }),
  );

  app.delete<{ Params: { id: string; index: string } }>('/api/decks/:id/slides/:index', (request, reply) =>
    respond(reply, async () => {
      await deleteDeckSlide(request.params.id, Number(request.params.index));
      return deckWithSlides(request.params.id);
    }),
  );

  app.put<{ Params: { id: string } }>('/api/decks/:id/theme', (request, reply) =>
    respond(reply, async () => {
      const parsed = restyleSchema.safeParse(request.body);
      if (!parsed.success) return badBody(reply, parsed.error);
      await restyleDeck(request.params.id, parsed.data.themeId, parsed.data.mode);
      return deckWithSlides(request.params.id);
    }),
  );

  app.get<{ Params: { id: string } }>('/api/decks/:id/file', async (request, reply) => {
    const job = await loadJob(request.params.id);
    if (!job || job.status !== 'done') return reply.code(404).send({ error: 'Presentation is not ready.' });
    const file = await fs.readFile(deckFilePath(job.id)).catch(() => null);
    if (!file) return reply.code(404).send({ error: 'Presentation file is missing.' });
    return reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation')
      .header('Content-Disposition', `attachment; filename="${job.fileName ?? 'presentation.pptx'}"`)
      .header('Cache-Control', 'no-store')
      .send(file);
  });
}
