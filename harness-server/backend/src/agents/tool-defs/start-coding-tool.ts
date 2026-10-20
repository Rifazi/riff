import { existsSync } from 'node:fs';
import path from 'node:path';
import { tool } from 'ai';
import { z } from 'zod';
import { config } from '../../config.js';
import { getSession, updateSession } from '../../sessions/session-store.js';
import { approvePlan, approveRequirements, StageActionError } from '../../sessions/stage-actions.js';

export const startCodingSchema = z.object({});

export const startCodingDescription =
  "Hand this pass to the coding agent. Call it only after you have written the requirements document (write_requirements_doc) and the plan " +
  '(write_plan_doc) and told the human what you found. When auto-drive is on it approves both documents, exactly as the human\'s Approve buttons do, and the ' +
  'session moves to the Coding tab, where the coding agent starts on its own; when it is off the documents stay drafts for the human to approve. After this call your job in this session is done: ' +
  'end your turn with one sentence. If the documents change afterwards, the human sends them back from the Coding tab.';

/** Approves the requirements and plan the UI/UX agent wrote, through the same code as the stage buttons. */
export function createStartCodingExecute(deps: { sessionId: string }) {
  return async (): Promise<string> => {
    let session = await getSession(deps.sessionId);
    if (!session) throw new Error('session not found');
    // The agent's own turn hasn't ended, so the session record doesn't know about the files it just wrote.
    const requirementsFile = path.join(config.requirementsDir, `${session.sessionKey}.md`);
    const planFile = path.join(config.plansDir, `${session.sessionKey}.md`);
    if (!existsSync(requirementsFile)) throw new Error('Write the requirements document with write_requirements_doc first.');
    if (!existsSync(planFile)) throw new Error('Write the plan with write_plan_doc first.');
    session = await updateSession(session.id, {
      requirementsPath: path.relative(config.harnessRoot, requirementsFile),
      requirementsStatus: session.requirementsStatus ?? 'draft',
      planPath: path.relative(config.harnessRoot, planFile),
      planStatus: session.planStatus ?? 'draft',
    });
    // Only Bridget approves on the human's behalf; with her off, the human reviews both documents first.
    if (!session.coordinatorEnabled) {
      return 'Requirements and plan saved as drafts. Auto-drive is off, so the human reviews and approves them before coding starts. ' +
        'Tell the human what you found and that both documents are ready to review, then end your turn.';
    }
    try {
      if (session.requirementsStatus !== 'approved') session = await approveRequirements(session);
      if (session.planStatus !== 'approved') session = await approvePlan(session);
    } catch (err) {
      if (err instanceof StageActionError) throw new Error(err.message);
      throw err;
    }
    return 'Requirements and plan approved. The coding agent starts on the Coding tab.';
  };
}

export function createStartCodingTool(deps: { sessionId: string }) {
  return tool({ description: startCodingDescription, inputSchema: startCodingSchema, execute: createStartCodingExecute(deps) });
}
