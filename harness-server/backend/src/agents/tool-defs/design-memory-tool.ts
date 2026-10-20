import { tool } from 'ai';
import { z } from 'zod';
import { changeDesignMemory, listDesignMemory } from '../../themes/design-memory.js';

export const rememberDesignSchema = z.object({
  add: z
    .array(
      z.object({
        text: z.string().min(1).describe('One decision, as an instruction a later agent can follow without this chat'),
        area: z.string().optional().describe('The screen or component it applies to; omit for the whole app'),
        source: z.enum(['human', 'agent']).describe('"human" when the human asked for it, "agent" when you decided it'),
      })
    )
    .optional(),
  replace: z
    .array(z.object({ id: z.string(), text: z.string().min(1), area: z.string().optional() }))
    .optional()
    .describe('Entries a new request changes: the id from the list and its new text'),
  remove: z.array(z.string()).optional().describe('Ids of entries the human withdrew or that no longer hold'),
});

export const rememberDesignDescription =
  "Keep a decision about how this app looks, so every later session and UI/UX pass follows it instead of redoing it. " +
  'Call it whenever the human asks for something about the look or feel (layout, spacing, a component\'s style, what ' +
  'must stay as it is, what must never come back) and when you make a design choice a later pass could undo. Write each ' +
  'entry as an instruction with the area it applies to ("Sidebar: stays flat, no glass or glow"), specific enough to ' +
  'check against a diff, never a hex value the theme owns. Not for one-off bugs or facts the code already shows. Use ' +
  'replace when a request changes an entry and remove when the human withdraws one. Returns the full list as it now stands.';

export function createRememberDesignExecute(deps: { appId: string; sessionId: string }) {
  return async ({ add, replace, remove }: z.infer<typeof rememberDesignSchema>): Promise<string> => {
    if (!add?.length && !replace?.length && !remove?.length) throw new Error('Nothing to remember, replace or remove.');
    const before = listDesignMemory(deps.appId).length;
    const entries = changeDesignMemory(deps.appId, deps.sessionId, { add, replace, remove });
    const list = entries.map((e) => `- [${e.id}] ${e.area ? `(${e.area}) ` : ''}${e.text}`).join('\n');
    return `Saved (${before} → ${entries.length} entries). Every later session and pass will be told:\n${list || '(empty)'}`;
  };
}

export function createRememberDesignTool(deps: { appId: string; sessionId: string }) {
  return tool({ description: rememberDesignDescription, inputSchema: rememberDesignSchema, execute: createRememberDesignExecute(deps) });
}
