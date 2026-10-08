import { tool } from 'ai';
import { z } from 'zod';
import { getSession, updateSession } from '../../sessions/session-store.js';
import { slugify, type SplitPart } from '../../sessions/session.js';

export const proposeSplitSchema = z.object({
  rationale: z
    .string()
    .describe('One or two sentences for the human: why this is too big for one requirements doc, and how you cut it.'),
  parts: z
    .array(
      z.object({
        title: z.string().describe('Short feature title for this slice, e.g. "Inventory report CSV export"'),
        brief: z
          .string()
          .describe(
            'Self-contained markdown brief for this slice: the goal, what is in and out of scope, known inputs/outputs, ' +
              'decisions already made in this conversation, and open questions. A separate requirements agent starts ' +
              'from ONLY this brief (plus the original meeting transcript, if any) — it never sees this conversation, ' +
              'so restate anything it needs.'
          ),
        outcome: z
          .string()
          .describe(
            'One sentence: what a user can do once this part ships, e.g. "Buyers can download the inventory report as CSV". ' +
              'Shown on the roadmap the human tracks progress on, and told to later parts so they build on it.'
          ),
        dependsOn: z
          .array(z.number().int().min(0))
          .describe('Zero-based indexes of EARLIER parts in this list that must be built first. Empty if independent.'),
      })
    )
    .min(2)
    .max(8)
    .describe(
      'The slices, in the order to build them. Put first what other parts need (data model, shared integration), then the ' +
        'part that gets something usable in front of users soonest; make the first part a thin end-to-end slice that ' +
        'works on its own. Riskiest unknowns early. Only list a dependsOn when the part truly needs that code, so ' +
        'independent parts can proceed side by side.'
    ),
});

export const proposeSplitDescription =
  'Propose splitting this feature into 2-8 separate requirements sessions, each of which then goes through its own ' +
  'requirements -> plan -> coding -> QA pipeline on its own branch. Use this when the request is really several ' +
  'features: parts that could ship and be reviewed independently, separate triggers/users/integrations, or a scope ' +
  'that would need more than roughly 10-12 acceptance criteria spanning unrelated areas, or more than one reviewable ' +
  'branch. Do NOT split a feature that is merely detailed, or cut by layer (e.g. "backend" / "frontend") when each ' +
  'half is useless alone — slice by user-visible outcome. Ask enough questions first to know where the seams are, ' +
  'then call this INSTEAD of write_requirements_doc. The order you give is the build order the human follows: a part ' +
  "can't start coding until the parts it depends on have shipped, and each part is told what the earlier ones delivered. " +
  'This only records a proposal: the human accepts it (which creates the sessions) or keeps the feature as one in the ' +
  'UI, so after calling it end your turn with no further text.';

/**
 * The agent can only propose a split — creating the child sessions is the
 * human-only /requirements/split/accept endpoint, same principle as every
 * approval gate in this project.
 */
export function createProposeSplitExecute(sessionInfo: { sessionId: string; sessionKey: string }) {
  return async ({ rationale, parts }: z.infer<typeof proposeSplitSchema>): Promise<string> => {
    const session = await getSession(sessionInfo.sessionId);
    if (!session) throw new Error('Session not found.');
    if (session.branch) {
      throw new Error('Coding has already started on this session — it can no longer be split. Revise its requirements instead.');
    }

    parts.forEach((part, i) => {
      for (const dep of part.dependsOn) {
        if (dep >= i) {
          throw new Error(
            `Part ${i} ("${part.title}") depends on part ${dep}, which is not earlier in the list. Order parts so each only depends on earlier ones.`
          );
        }
      }
    });

    const usedKeys = new Set<string>();
    const splitParts: SplitPart[] = parts.map((part, i) => {
      let key = `${sessionInfo.sessionKey}-${slugify(part.title).slice(0, 30) || i + 1}`.replace(/-+$/, '');
      while (usedKeys.has(key)) key = `${key}-${i + 1}`;
      usedKeys.add(key);
      return {
        title: part.title.trim(),
        sessionKey: key,
        brief: part.brief.trim(),
        outcome: part.outcome.trim(),
        dependsOn: [...new Set(part.dependsOn)],
      };
    });

    await updateSession(sessionInfo.sessionId, {
      splitProposal: { rationale: rationale.trim(), parts: splitParts, proposedAt: new Date().toISOString() },
    });

    return (
      `Proposed splitting this feature into ${splitParts.length} sessions: ${splitParts.map((p) => `"${p.title}"`).join(', ')}. ` +
      'The human will accept it or keep the feature as one in the UI — end your turn now.'
    );
  };
}

export function createProposeSplitTool(sessionInfo: { sessionId: string; sessionKey: string }) {
  return tool({
    description: proposeSplitDescription,
    inputSchema: proposeSplitSchema,
    execute: createProposeSplitExecute(sessionInfo),
  });
}
