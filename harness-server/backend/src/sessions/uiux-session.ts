import { v4 as uuidv4 } from 'uuid';
import type { AppConfig } from '../apps/apps.js';
import { createSession, updateSession } from './session-store.js';
import { uniqueSessionKey } from './session-keys.js';
import type { SessionRecord } from './session.js';

export interface UiuxPassInput {
  title: string;
  /** What to look at: screens, flows or a general concern. Empty = the whole UI. */
  focus?: string;
}

/**
 * A session whose first stage is the UI/UX lead (agents/uiux-agent.ts) instead
 * of the requirements analyst. It opens on the Requirements tab, where the
 * frontend sends the kickoff message; the lead writes the requirements and the
 * plan and approves both with start_coding, so the session moves to Coding on
 * its own. QA and delivery are the ordinary ones.
 */
export async function createUiuxSession(app: AppConfig, input: UiuxPassInput): Promise<SessionRecord> {
  const title = input.title.trim();
  const id = uuidv4();
  const sessionKey = await uniqueSessionKey({ title: `uiux ${title}` });
  await createSession({ id, title, sessionKey, appId: app.id, kind: 'uiux' });
  return updateSession(id, { uiuxFocus: input.focus?.trim() || null });
}
