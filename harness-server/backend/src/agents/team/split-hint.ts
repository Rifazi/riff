import matter from 'gray-matter';
import { planStepSection } from '../plan-excerpt.js';

// What Jack needs from the plan to decide team or solo at kickoff: the files
// each step names. He used to read the whole plan (23k chars in session
// 7bdd0d9e) and then carry it in every request until the next cut, only to
// call build_solo because the steps formed one sequential chain.

export interface StepFiles {
  id: string;
  title: string;
  files: string[];
}

interface PlanStepRef {
  id: string;
  title: string;
}

// A backticked token that names a file or folder: has a slash or an extension, no spaces.
const PATH_TOKEN = /`([^`\s]+)`/g;
const looksLikePath = (t: string) => /^[\w@.\-/[\]()]+$/.test(t) && (t.includes('/') || /\.[A-Za-z][A-Za-z0-9]{0,5}$/.test(t)) && !/^\.+$/.test(t);

/** Each plan step's backticked file and folder names, in plan order. Steps whose section can't be found get none. */
export function stepFiles(planRaw: string, steps?: PlanStepRef[]): StepFiles[] {
  const fm: unknown = matter(planRaw).data.steps;
  const list = steps ?? (Array.isArray(fm) ? (fm as PlanStepRef[]) : []);
  return list.map((step) => {
    const section = planStepSection(planRaw, step.id) ?? '';
    const files = new Set<string>();
    for (const m of section.matchAll(PATH_TOKEN)) {
      const t = m[1].replace(/^\.\//, '').replace(/[),.:;]+$/, '');
      if (looksLikePath(t)) files.add(t);
    }
    return { id: step.id, title: step.title, files: [...files] };
  });
}

/** Whether two names a plan uses can be the same file: equal, or one is a path ending in the other. */
export function sameFile(a: string, b: string): boolean {
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

// Names every step of a plan can mention without sharing any work: the doc each
// domain keeps, root config, and a bare `service.ts`/`index.ts` that names a
// different file in each folder. Session a258f09a's 19 steps across five
// independent domains all named `DOMAIN.md`, so they looked like one chain
// and were built solo.
const SHARED_NAMES = /^(DOMAIN\.md|MAP\.md|README\.md|CHANGELOG\.md|package(-lock)?\.json|tsconfig[\w.-]*\.json|pnpm-lock\.yaml|yarn\.lock)$/;
const GENERIC_BARE = /^(service|index|types|constants|utils|infra)\.[A-Za-z]+$/;

/** Whether a step's file token names something the step owns, so sharing it with another step means they depend on each other. */
function ownedFile(file: string): boolean {
  if (file.startsWith('.')) return false;
  const base = file.slice(file.lastIndexOf('/') + 1);
  if (SHARED_NAMES.test(base)) return false;
  return file.includes('/') || !GENERIC_BARE.test(base);
}

/**
 * Why this plan is built solo without asking the lead, or null when it's
 * his call. Only for plans where a split can't help: a single step, or steps
 * whose files all connect (each step shares an owned file with another, down
 * to one group), so there is no part that could be built beside the rest.
 */
export function soloReason(steps: StepFiles[]): string | null {
  if (steps.length < 2) return 'The plan has a single step.';
  const owned = steps.map((s) => s.files.filter(ownedFile));
  if (owned.some((files) => files.length === 0)) return null;
  const group = steps.map((_, i) => i);
  const find = (i: number): number => (group[i] === i ? i : (group[i] = find(group[i])));
  for (let i = 0; i < steps.length; i++) {
    for (let k = i + 1; k < steps.length; k++) {
      if (owned[i].some((f) => owned[k].some((g) => sameFile(f, g)))) group[find(k)] = find(i);
    }
  }
  if (new Set(steps.map((_, i) => find(i))).size > 1) return null;
  return 'Every step works on files shared with the others, so the steps run one after another and none could be built in parallel.';
}

/** One line per step with the files it names, for the lead's kickoff prompt. */
export function stepFilesMap(steps: StepFiles[]): string {
  return steps
    .map((s) => `- ${s.id} (${s.title}): ${s.files.length ? s.files.map((f) => `\`${f}\``).join(', ') : 'no files named'}`)
    .join('\n');
}
