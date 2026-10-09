import { promises as fs } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { listSessions } from './session-store.js';
import { slugify } from './session.js';

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

// Every stage's own agent derives its doc's filename straight from
// sessionKey (requirementsDir/<key>.md, plansDir/<key>.md, ...) with no
// further uniqueness check of its own — see requirements-agent.ts's
// "does a file already exist at this path" adoption logic. Two sessions
// sharing a key silently merge onto the same file: the newer session would
// inherit the older one's approved status on its very first turn, and a
// later write would overwrite the older session's document outright. So a
// key is taken if any session uses it OR any artifact doc already exists
// under it.
export async function isSessionKeyInUse(key: string): Promise<boolean> {
  const sessions = await listSessions();
  if (sessions.some((s) => s.sessionKey === key)) return true;
  const hits = await Promise.all(
    [config.requirementsDir, config.plansDir, config.qaReportsDir].map((dir) => fileExists(path.join(dir, `${key}.md`)))
  );
  return hits.some(Boolean);
}

// A free key for a new session. A ticket isn't unique — several sessions can
// belong to one — so it's only the starting point: the bare ticket if free,
// else the ticket plus the title's slug, then a counter.
export async function uniqueSessionKey(input: { ticket?: string | null; title: string }): Promise<string> {
  // Keys name files, so keep only filename-safe characters.
  const ticket = input.ticket?.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|-+$/g, '');
  const titleSlug = slugify(input.title).slice(0, 40).replace(/-+$/, '');
  const candidates = ticket ? [ticket, titleSlug ? `${ticket}-${titleSlug}` : ticket] : [titleSlug || 'session'];
  for (const key of candidates) {
    if (!(await isSessionKeyInUse(key))) return key;
  }
  const base = candidates[candidates.length - 1];
  for (let n = 2; ; n++) {
    if (!(await isSessionKeyInUse(`${base}-${n}`))) return `${base}-${n}`;
  }
}
