import { randomUUID } from 'node:crypto';
import { tool } from 'ai';
import { z } from 'zod';
import { mutateSession } from '../../sessions/session-store.js';
import type { QaNote } from '../../sessions/session.js';

export const noteForQaSchema = z.object({
  notes: z
    .array(z.string().min(1))
    .describe('One note per item, each a sentence or two QA can act on without your chat'),
  replace: z
    .boolean()
    .optional()
    .describe('Drop the notes you left earlier (that QA has not received yet) and keep only these — for when one went stale'),
});

export const noteForQaDescription =
  'Leave notes for QA. They are handed to the QA agent, along with the branch, when the human approves the diff ' +
  'and starts QA. QA sees the requirements and the diff but not your chat, so note only what it couldn\'t work out ' +
  'from those: a requirement you deliberately didn\'t meet or met differently (and why), known gaps or flaky ' +
  'checks, setup a reviewer needs (env vars, seed data, a migration, a flag), areas that deserve extra scrutiny, ' +
  'or something that looks wrong but is intentional. Don\'t restate the plan or list the files you changed. Call ' +
  'it whenever one comes up; pass replace: true to rewrite your notes when an earlier one no longer holds.';

/**
 * Appends to session.qaNotes, which coding/approve hands over as
 * qaHandoffNotes for the QA agent's next fresh conversation. `from` is the
 * workstream's title for a team engineer, null for the coding agent itself.
 */
export function createNoteForQaExecute(deps: { sessionId: string; from: string | null }) {
  return async ({ notes, replace }: z.infer<typeof noteForQaSchema>): Promise<string> => {
    const texts = notes.map((n) => n.trim()).filter(Boolean);
    if (!texts.length) throw new Error('No notes given.');
    const at = new Date().toISOString();
    let total = 0;
    await mutateSession(deps.sessionId, (s) => {
      const kept = replace ? s.qaNotes.filter((n) => n.from !== deps.from) : s.qaNotes;
      s.qaNotes = [...kept, ...texts.map((text) => ({ id: randomUUID(), from: deps.from, text, at }))];
      total = s.qaNotes.length;
    });
    return `Noted for QA (${total} note${total === 1 ? '' : 's'} waiting for QA). They go over when the human starts QA.`;
  };
}

export function createNoteForQaTool(deps: { sessionId: string; from: string | null }) {
  return tool({ description: noteForQaDescription, inputSchema: noteForQaSchema, execute: createNoteForQaExecute(deps) });
}

/** The handed-over notes as a system-prompt section for QA, or '' when there are none. */
export function qaHandoffSection(notes: QaNote[]): string {
  if (!notes.length) return '';
  const lines = notes.map((n) => `- ${n.from ? `(${n.from}) ` : ''}${n.text}`).join('\n');
  return (
    `\n\n# Notes from the coding agent\n\nLeft for QA while the branch was built: known gaps, deliberate deviations, ` +
    `setup, areas worth a closer look. Use them to aim the review, but verify them like anything else — they ` +
    `don't replace checking every acceptance criterion, and a gap they admit to is still a finding.\n\n${lines}`
  );
}
