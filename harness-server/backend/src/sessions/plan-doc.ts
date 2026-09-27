import { promises as fs } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { z } from 'zod';
import { config } from '../config.js';
import type { PlanWorkstream, SessionRecord } from './session.js';

export const planWorkstreamSchema = z.object({
  id: z.string().describe('Short stable slug, e.g. "api", "ui", "foundation"'),
  title: z.string().describe('What this team member builds, e.g. "Report API endpoint"'),
  stepIds: z.array(z.string()).min(1).describe('Ids of the plan steps this member implements, in order'),
  ownedPaths: z
    .array(z.string())
    .min(1)
    .describe(
      'Repo-relative files or directories ONLY this member may write, e.g. ["src/api/reports/", "src/api/routes.ts"]. ' +
        'Must not overlap any other workstream\'s paths — a shared file (package.json, a route registry, shared types) ' +
        'belongs to exactly one workstream, usually a foundation one the others depend on.'
    ),
  dependsOn: z
    .array(z.string())
    .describe('Ids of workstreams that must be finished and merged before this one starts. Empty to start immediately.'),
});

export class InvalidWorkstreamsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidWorkstreamsError';
  }
}

function normalizeOwnedPath(p: string): string {
  const trimmed = p.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (!trimmed || trimmed === '.' || path.isAbsolute(trimmed) || trimmed.split('/').includes('..')) {
    throw new InvalidWorkstreamsError(`"${p}" isn't a usable owned path — use a repo-relative file or directory below the root.`);
  }
  return trimmed;
}

function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/**
 * Checks a plan's workstreams are safe to run as a concurrent team: every
 * step assigned exactly once, owned paths disjoint across workstreams (the
 * file tools enforce ownership, so disjoint paths mean merges can't
 * conflict), dependencies known and acyclic, and at least two workstreams
 * that can genuinely run at the same time — a pure chain is just the normal
 * sequential mode with extra overhead. Returns them with owned paths
 * normalized.
 */
export function validateWorkstreams(stepIds: string[], workstreams: PlanWorkstream[]): PlanWorkstream[] {
  if (workstreams.length < 2) {
    throw new InvalidWorkstreamsError('A team plan needs at least two workstreams — omit `workstreams` for a single coding agent.');
  }
  const ids = new Set<string>();
  for (const ws of workstreams) {
    if (ids.has(ws.id)) throw new InvalidWorkstreamsError(`Duplicate workstream id "${ws.id}".`);
    ids.add(ws.id);
  }

  const owner = new Map<string, string>();
  for (const ws of workstreams) {
    for (const stepId of ws.stepIds) {
      if (!stepIds.includes(stepId)) throw new InvalidWorkstreamsError(`Workstream "${ws.id}" lists unknown step "${stepId}".`);
      const prev = owner.get(stepId);
      if (prev) throw new InvalidWorkstreamsError(`Step "${stepId}" is in both "${prev}" and "${ws.id}" — each step belongs to one workstream.`);
      owner.set(stepId, ws.id);
    }
  }
  const unassigned = stepIds.filter((id) => !owner.has(id));
  if (unassigned.length) throw new InvalidWorkstreamsError(`Steps not in any workstream: ${unassigned.join(', ')}.`);

  const normalized = workstreams.map((ws) => ({
    ...ws,
    ownedPaths: [...new Set(ws.ownedPaths.map(normalizeOwnedPath))],
    dependsOn: [...new Set(ws.dependsOn)],
  }));
  for (let i = 0; i < normalized.length; i++) {
    for (let j = i + 1; j < normalized.length; j++) {
      for (const a of normalized[i].ownedPaths) {
        for (const b of normalized[j].ownedPaths) {
          if (overlaps(a, b)) {
            throw new InvalidWorkstreamsError(
              `"${normalized[i].id}" owns "${a}" and "${normalized[j].id}" owns "${b}" — they overlap. Give the shared ` +
                'path to one workstream and make the other depend on it, or merge the two workstreams.'
            );
          }
        }
      }
    }
  }

  for (const ws of normalized) {
    for (const dep of ws.dependsOn) {
      if (dep === ws.id) throw new InvalidWorkstreamsError(`Workstream "${ws.id}" depends on itself.`);
      if (!ids.has(dep)) throw new InvalidWorkstreamsError(`Workstream "${ws.id}" depends on unknown workstream "${dep}".`);
    }
  }

  // Transitive dependencies — also detects cycles.
  const byId = new Map(normalized.map((ws) => [ws.id, ws]));
  const ancestors = new Map<string, Set<string>>();
  const visit = (id: string, trail: string[]): Set<string> => {
    if (trail.includes(id)) throw new InvalidWorkstreamsError(`Workstream dependencies form a cycle: ${[...trail, id].join(' → ')}.`);
    const cached = ancestors.get(id);
    if (cached) return cached;
    const all = new Set<string>();
    for (const dep of byId.get(id)!.dependsOn) {
      all.add(dep);
      for (const a of visit(dep, [...trail, id])) all.add(a);
    }
    ancestors.set(id, all);
    return all;
  };
  normalized.forEach((ws) => visit(ws.id, []));

  const parallelPair = normalized.some((a) =>
    normalized.some((b) => a.id !== b.id && !ancestors.get(a.id)!.has(b.id) && !ancestors.get(b.id)!.has(a.id))
  );
  if (!parallelPair) {
    throw new InvalidWorkstreamsError(
      'Every workstream waits on another, so nothing would run in parallel — omit `workstreams` and keep the plan sequential.'
    );
  }

  return normalized;
}

export interface PlanDocData {
  steps: { id: string; title: string }[];
  workstreams: PlanWorkstream[];
}

export async function readPlanDoc(session: SessionRecord): Promise<PlanDocData> {
  if (!session.planPath) return { steps: [], workstreams: [] };
  try {
    const parsed = matter(await fs.readFile(path.join(config.harnessRoot, session.planPath), 'utf8'));
    const steps = Array.isArray(parsed.data.steps) ? (parsed.data.steps as PlanDocData['steps']) : [];
    const workstreams = Array.isArray(parsed.data.workstreams) ? (parsed.data.workstreams as PlanWorkstream[]) : [];
    return { steps, workstreams };
  } catch {
    return { steps: [], workstreams: [] };
  }
}
