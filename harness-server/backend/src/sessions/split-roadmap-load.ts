import { promises as fs } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { config } from '../config.js';
import type { SessionRecord } from './session.js';
import { getSession, listSessions } from './session-store.js';
import { acceptanceCriteria, buildSplitRoadmap, roadmapProgressBrief, type SplitRoadmap } from './split-roadmap.js';

/** The roadmap a session belongs to — its own if it was split, its parent's if it's a part. Null otherwise. */
export async function loadSplitRoadmap(session: SessionRecord): Promise<SplitRoadmap | null> {
  const parent = session.splitInto.length > 0 ? session : session.splitFrom ? await getSession(session.splitFrom.sessionId) : null;
  if (!parent || parent.splitInto.length === 0) return null;
  return buildSplitRoadmap(parent, await listSessions());
}

/** A part's place in the roadmap right now, with what the shipped parts delivered. Null if it isn't a part. */
export async function loadProgressBrief(session: SessionRecord): Promise<string | null> {
  const roadmap = await loadSplitRoadmap(session);
  const index = roadmap?.parts.findIndex((p) => p.sessionId === session.id) ?? -1;
  if (!roadmap || index < 0) return null;

  const criteria = new Map<string, string | null>();
  for (const part of roadmap.parts) {
    if (part.status !== 'shipped') continue;
    const child = await getSession(part.sessionId);
    let text: string | null = null;
    if (child?.requirementsPath) {
      try {
        text = acceptanceCriteria(matter(await fs.readFile(path.join(config.harnessRoot, child.requirementsPath), 'utf8')).content);
      } catch {
        // doc deleted outside the app
      }
    }
    criteria.set(part.sessionId, text);
  }
  return roadmapProgressBrief(roadmap, index, (p) => criteria.get(p.sessionId) ?? null);
}
