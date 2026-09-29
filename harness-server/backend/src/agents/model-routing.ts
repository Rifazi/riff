import { promises as fs } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { config } from '../config.js';
import type { SessionRecord } from '../sessions/session.js';
import { DEFAULT_LIGHT_MODEL, type RoleModelConfig } from '../settings/settings.js';

// Automatic model routing for coding. The plan agent tags each plan step
// "light" or "standard" (write_plan_doc's `effort`) — it has read the
// requirements and the code, so it is the one placed to judge. A light
// step's automatic turn runs on the cheaper model; if that model errors or
// doesn't finish the step, the full model takes over in the same turn
// (see coding-agent.ts / team/coding-team.ts). Human-typed follow-ups, QA
// fixes and the requirements/plan/QA roles always use the full model.

export type StepEffort = 'light' | 'standard';

/** The light model to use, or null when routing is off for this role. */
export function lightModelFor(cfg: RoleModelConfig): string | null {
  const light = cfg.lightModel === undefined ? DEFAULT_LIGHT_MODEL[cfg.provider] : cfg.lightModel.trim();
  if (!light || light === cfg.model) return null;
  return light;
}

/** Plan step id → effort, from the approved plan's frontmatter. Untagged steps are standard. */
export async function planStepEfforts(session: SessionRecord): Promise<Map<string, StepEffort>> {
  const efforts = new Map<string, StepEffort>();
  if (!session.planPath) return efforts;
  try {
    const raw = await fs.readFile(path.join(config.harnessRoot, session.planPath), 'utf8');
    const steps: unknown = matter(raw).data.steps;
    if (Array.isArray(steps)) {
      for (const step of steps as { id?: unknown; effort?: unknown }[]) {
        if (typeof step.id === 'string') efforts.set(step.id, step.effort === 'light' ? 'light' : 'standard');
      }
    }
  } catch {
    // plan unreadable — everything runs standard
  }
  return efforts;
}

/**
 * The step the next single-agent coding turn will work on: the in-progress
 * one, else the first pending one, else (before write_coding_plan has run)
 * the plan's first step.
 */
export function nextCodingStepId(session: SessionRecord, efforts: Map<string, StepEffort>): string | null {
  const plan = session.codingPlan;
  if (plan && plan.length > 0) {
    return (plan.find((s) => s.status === 'in_progress') ?? plan.find((s) => s.status === 'pending'))?.id ?? null;
  }
  return efforts.keys().next().value ?? null;
}
