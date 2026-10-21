import { generateText } from 'ai';
import { z } from 'zod';
import { resolveLanguageModel, runClaudeSingleShot } from '../agents/sdk-client.js';
import { getApiKey, getRoleModelConfig } from '../settings/settings-store.js';
import type { ApiKeyProvider } from '../settings/settings.js';
import { lessonVerdict, type LessonDraft, type RetroFacts, type StoredLesson, type SystemSuggestion } from './core.js';
import { suggestionVerdict, type TrackedSuggestion } from './suggestion-tracker.js';

export const RETRO_INSTRUCTIONS = `You review how one feature went through an AI development pipeline (requirements -> plan -> coding -> QA) and say what to change so the next feature goes through with fewer QA rounds. You see every QA pass's blocking findings and which ones came back, plus the lessons already on file for this app.

Respond with ONLY one JSON object, no other text:
{
  "summary": "<2-3 sentences: why QA sent this branch back, in plain words>",
  "lessons": [{"text": "<one instruction a coding or QA agent on this app can follow without any other context>", "area": "<folder, screen or feature it applies to, or null>", "roles": ["plan" | "coding" | "qa"]}],
  "suggestions": [{"title": "<short>", "detail": "<what to change and why this session shows it>", "target": "plan" | "coding" | "qa" | "pipeline", "instruction": "<for an agent target: the instruction itself, addressed to that agent>"}]
}

Lessons:
- At most 4. Each must be about this app's code or conventions and drawn from the findings: "When adding a new X, also update A, B and C" beats "be careful".
- Skip anything the lessons already on file say, and one-off bugs that teach nothing about the next feature.
- No file or line numbers that only matter to this branch.

Suggestions:
- At most 3, about the pipeline (what ran when, what a gate could check without QA, what an agent was told or not told), not about this app's code.
- target "plan", "coding" or "qa" when the fix is something that agent should do differently: write the instruction itself, and Riff adds it to that agent's briefing from now on. target "pipeline" only when it takes a code change (a gate, a tool, the flow), which a human will decide on.
- Skip a suggestion you can't tie to something in the findings, and any that repeats a lesson or an earlier suggestion.
- Riff measures every lesson and suggestion over later sessions and drops the ones that don't help, so only write ones you expect to change what happens.
- "roles" on a lesson says whose briefing it goes in; leave it out for all three.

Empty arrays are fine and right when nothing generalizes.`;

const ROLES = ['plan', 'coding', 'qa'] as const;

const draftSchema = z.object({
  summary: z.string().max(1200).default(''),
  lessons: z
    .array(z.object({ text: z.string().min(12).max(400), area: z.string().max(80).nullish(), roles: z.array(z.enum(ROLES)).min(1).optional() }))
    .max(4)
    .default([]),
  suggestions: z
    .array(
      z.object({
        title: z.string().min(3).max(100),
        detail: z.string().min(10).max(600),
        target: z.enum(['plan', 'coding', 'qa', 'pipeline']).default('pipeline'),
        instruction: z.string().min(12).max(400).optional(),
      }),
    )
    .max(3)
    .default([]),
});

export interface ModelRetro {
  summary: string;
  lessons: LessonDraft[];
  suggestions: SystemSuggestion[];
}

export function parseModelRetro(raw: string): ModelRetro | null {
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    const parsed = draftSchema.safeParse(JSON.parse(match ? match[0] : raw));
    if (!parsed.success) return null;
    const lessons: LessonDraft[] = parsed.data.lessons.map((l) => ({
      text: l.text.trim(),
      area: l.area?.trim() || null,
      category: 'app' as const,
      ...(l.roles ? { roles: l.roles } : {}),
      source: 'model' as const,
    }));
    const suggestions: SystemSuggestion[] = [];
    // A suggestion about what an agent should do is acted on: it goes into that agent's briefing.
    for (const s of parsed.data.suggestions) {
      if (s.target !== 'pipeline') {
        lessons.push({ text: (s.instruction ?? s.detail).trim(), area: null, category: 'process', roles: [s.target], source: 'model' });
      } else {
        suggestions.push({ code: null, title: s.title.trim(), detail: s.detail.trim() });
      }
    }
    return { summary: parsed.data.summary.trim(), lessons, suggestions };
  } catch {
    return null;
  }
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)} […]` : s);

export function retroPrompt(params: { title: string; facts: RetroFacts; rounds: { pass: number; result: string | null; blocking: string[]; notes: string[] }[]; lessons: StoredLesson[]; tracked: TrackedSuggestion[] }): string {
  const { facts, rounds, lessons } = params;
  const passes = rounds
    .map((r) => {
      const blockers = r.blocking.map((b) => `  - ${clip(b, 420)}`).join('\n') || '  (none)';
      const notes = r.notes.length ? `\n  Notes: ${r.notes.map((n) => clip(n, 160)).join(' | ')}` : '';
      return `Pass ${r.pass}: ${r.result ?? 'no result'}\n${blockers}${notes}`;
    })
    .join('\n');
  const how = Object.entries(facts.byKind).map(([k, n]) => `${n} ${k}`).join(', ') || 'none';
  const known =
    lessons
      .map((l) => {
        const v = lessonVerdict(l);
        const state = l.status === 'active' ? (v === 'unproven' ? '' : ` [${v}: came back in ${l.recurredSessionIds.length} of ${l.exposedSessionIds.length} sessions that had it]`) : ` [${l.status}: don't write it again]`;
        return `- ${l.text}${state}`;
      })
      .join('\n') || '(none yet)';
  const past =
    params.tracked
      .map((t) => `- ${t.title} [${t.status}${t.status === 'done' ? `, ${suggestionVerdict(t)}` : ''}]`)
      .join('\n') || '(none yet)';
  return (
    `Feature: ${params.title}\nQA passes: ${facts.passes} (${facts.failedPasses} failed). Blockers that came back: ${how}.\n` +
    `Failed passes where the branch hadn't changed: ${facts.unchangedResends.join(', ') || 'none'}.\n\n${passes}\n\n` +
    `Lessons already on file for this app (with how they have worked out):\n${known}\n\nSuggestions made before (don't repeat muted, dismissed or done ones unless the findings show they failed):\n${past}\n\nWrite the JSON.`
  );
}

/** Asks the coordinator's configured model for the app-specific half of the retrospective. Null on any failure. */
export async function askModel(prompt: string): Promise<ModelRetro | null> {
  try {
    const { provider, model } = await getRoleModelConfig('coordinator');
    if (provider === 'claude') {
      return parseModelRetro(await runClaudeSingleShot({ systemPrompt: RETRO_INSTRUCTIONS, prompt, model, effort: 'medium' }));
    }
    const apiKey = await getApiKey(provider);
    if (apiKey === null) return null;
    const languageModel = await resolveLanguageModel(provider as ApiKeyProvider, model, apiKey);
    const { text } = await generateText({ model: languageModel, system: RETRO_INSTRUCTIONS, prompt });
    return parseModelRetro(text);
  } catch (err) {
    console.warn('[retrospective] model pass failed:', err instanceof Error ? err.message : err);
    return null;
  }
}
