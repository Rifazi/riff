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

/**
 * Why this plan is built solo without asking the lead, or null when it's
 * his call. Only for plans where a split can't help: a single step, or a
 * chain where every step names a file the step before it names, so each
 * builds on the last and no two could run at once.
 */
export function soloReason(steps: StepFiles[]): string | null {
  if (steps.length < 2) return 'The plan has a single step.';
  for (let i = 1; i < steps.length; i++) {
    const shared = steps[i].files.find((f) => steps[i - 1].files.some((g) => sameFile(f, g)));
    if (!shared) return null;
  }
  return 'Every step works on a file the step before it touches, so the steps run one after another and none could be built in parallel.';
}

/** One line per step with the files it names, for the lead's kickoff prompt. */
export function stepFilesMap(steps: StepFiles[]): string {
  return steps
    .map((s) => `- ${s.id} (${s.title}): ${s.files.length ? s.files.map((f) => `\`${f}\``).join(', ') : 'no files named'}`)
    .join('\n');
}
