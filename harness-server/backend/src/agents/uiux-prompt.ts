import { promises as fs } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import type { SessionRecord } from '../sessions/session.js';

const PROMPT_PATH = path.join(config.harnessRoot, 'backend/src/agents/prompts/uiux-coding.md');

const STYLE_PATH = path.join(config.harnessRoot, 'backend/src/agents/prompts/uiux-style.md');

/** The house style, written against theme tokens so any theme carries it. */
export async function uiuxStylePrompt(): Promise<string> {
  return `\n\n${await fs.readFile(STYLE_PATH, 'utf8')}`;
}

/**
 * What a UI/UX pass adds to the coding prompt. It goes after the app's
 * override too, since an override replaces the base prompt wholesale.
 */
export async function uiuxPromptFor(session: SessionRecord): Promise<string> {
  return session.kind === 'uiux' ? `${await fs.readFile(PROMPT_PATH, 'utf8')}${await uiuxStylePrompt()}` : '';
}
