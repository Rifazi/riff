import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { tool } from 'ai';
import { z } from 'zod';
import { mutateSession } from '../../sessions/session-store.js';

export const widenFixScopeSchema = z.object({
  paths: z.array(z.string().min(1)).min(1).describe('Repo-relative files or folders the fix also has to change'),
  reason: z.string().min(1).describe('Why the fix needs them, one or two sentences; QA reads this'),
});
export const widenFixScopeDescription =
  "During a QA fix your write tools accept only the files QA's findings named (plus tests and fixtures next to " +
  'them). Call this first when a fix genuinely needs another file: the paths are added to your scope and the ' +
  'reason goes to QA as a note. Not for touching things QA didn\'t ask about.';

function normalize(p: string): string {
  const rel = p.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (!rel || path.isAbsolute(rel) || rel.split('/').includes('..')) throw new Error(`"${p}" isn't a repo-relative path.`);
  return rel;
}

export function createWidenFixScopeExecute(deps: { sessionId: string }) {
  return async ({ paths, reason }: z.infer<typeof widenFixScopeSchema>): Promise<string> => {
    const added = [...new Set(paths.map(normalize))];
    let scoped = false;
    await mutateSession(deps.sessionId, (s) => {
      if (!s.fixScope) return;
      scoped = true;
      const at = new Date().toISOString();
      s.fixScope.paths = [...new Set([...s.fixScope.paths, ...added])];
      s.fixScope.widened.push({ paths: added, reason: reason.trim(), at });
      s.qaNotes.push({
        id: randomUUID(),
        from: null,
        text: `Widened the fix beyond the files QA named, to ${added.join(', ')}: ${reason.trim()}`,
        at,
      });
    });
    if (!scoped) return 'No fix scope is set on this session: your write tools already accept any file.';
    return `Added to your fix scope: ${added.join(', ')}. QA will see why.`;
  };
}

export function createWidenFixScopeTool(deps: { sessionId: string }) {
  return tool({ description: widenFixScopeDescription, inputSchema: widenFixScopeSchema, execute: createWidenFixScopeExecute(deps) });
}
