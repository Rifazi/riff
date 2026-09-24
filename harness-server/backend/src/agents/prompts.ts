import { promises as fs } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import type { Role } from '../settings/settings.js';
import { DECISION_INSTRUCTIONS } from './coordinator-agent.js';

// Maps a role to its checked-in base prompt file — kept in one place for
// the Apps page's "view base prompt" read; each *-agent.ts still reads its
// own file directly at turn time (same duplication tradeoff as
// sessions/stage-group.ts's frontend/backend split: one extra place to keep
// in sync beats a shared module neither side otherwise needs).
const PROMPT_FILE: Partial<Record<Role, string>> = {
  requirements: 'requirements-agent.md',
  plan: 'plan-agent.md',
  coding: 'coding-agent.md',
  qa: 'qa-agent.md',
};

// "coordinator" has no prompt file — its base is the inline
// DECISION_INSTRUCTIONS constant in coordinator-agent.ts.
export async function readBasePrompt(role: Role): Promise<string | null> {
  if (role === 'coordinator') return DECISION_INSTRUCTIONS;
  const file = PROMPT_FILE[role];
  if (!file) return null;
  try {
    return await fs.readFile(path.join(config.harnessRoot, 'backend/src/agents/prompts', file), 'utf8');
  } catch {
    return null;
  }
}
