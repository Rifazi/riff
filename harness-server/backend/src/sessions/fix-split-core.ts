import type { QaFixSplit } from './session.js';
import { findingFiles } from './qa-loop.js';

export const FIX_SPLIT_INSTRUCTIONS = `You are the plan agent. QA has blocked this branch on the same file in more than one pass, which usually means the step that produced it was too big or unclear. Before a further fix attempt, split the fix for those files into small steps the coder can do and prove one at a time.

Respond with ONLY one JSON object, no other text:
{"steps": [{"title": "<short>", "files": ["<path>"], "instruction": "<what to change and the test that proves it, in one or two sentences>"}]}

Rules:
- 2 to 5 steps, in the order to do them. Each step changes one thing and can be committed on its own.
- Every blocker that names one of the files must be covered by exactly one step.
- Stay inside what the blockers ask for. Do not add work, refactors or new requirements.
- Name only files the blockers or the plan name.`;

export function parseFixSplit(raw: string, pass: number, files: string[]): QaFixSplit | null {
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    const data = JSON.parse(match ? match[0] : raw) as { steps?: unknown };
    if (!Array.isArray(data.steps)) return null;
    const steps = data.steps
      .map((s): QaFixSplit['steps'][number] | null => {
        const o = s as Record<string, unknown>;
        if (typeof o?.title !== 'string' || typeof o.instruction !== 'string') return null;
        const fs = Array.isArray(o.files) ? o.files.filter((f): f is string => typeof f === 'string') : [];
        return { title: o.title.trim().slice(0, 100), files: fs.slice(0, 6), instruction: o.instruction.trim().slice(0, 500) };
      })
      .filter((s): s is QaFixSplit['steps'][number] => s !== null && s.title.length > 0 && s.instruction.length > 0)
      .slice(0, 5);
    return steps.length >= 2 ? { pass, files, steps } : null;
  } catch {
    return null;
  }
}

export function fixSplitPrompt(params: { title: string; files: string[]; blockers: string[]; planSteps: string[] }): string {
  const mine = params.blockers.filter((b) => findingFiles(b).some((f) => params.files.includes(f)));
  const clip = (s: string) => (s.length > 600 ? `${s.slice(0, 600)} […]` : s);
  return (
    `Feature: ${params.title}\nFiles QA blocked on in more than one pass: ${params.files.join(', ')}\n\n` +
    `Latest blockers on those files:\n${mine.map((b) => `- ${clip(b)}`).join('\n') || '(none named a file)'}\n\n` +
    `Plan steps:\n${params.planSteps.map((s) => `- ${s}`).join('\n') || '(none recorded)'}\n\nWrite the JSON.`
  );
}

export function fixSplitBrief(split: QaFixSplit): string {
  const steps = split.steps.map((s, i) => `${i + 1}. ${s.title}${s.files.length ? ` (${s.files.join(', ')})` : ''}: ${s.instruction}`);
  return (
    `${split.files.join(', ')} blocked QA in more than one pass, so the plan agent split that fix into steps. ` +
    `Do them in this order, one commit and one test each, and finish each before starting the next:\n${steps.join('\n')}`
  );
}
