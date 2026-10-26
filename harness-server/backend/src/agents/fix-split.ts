import { generateText } from 'ai';
import { getApiKey, getRoleModelConfig } from '../settings/settings-store.js';
import type { ApiKeyProvider } from '../settings/settings.js';
import { FIX_SPLIT_INSTRUCTIONS, fixSplitPrompt, parseFixSplit } from '../sessions/fix-split-core.js';
import { hotBlockerFiles, type QaRoundRecord } from '../sessions/qa-loop.js';
import type { QaFixSplit, SessionRecord } from '../sessions/session.js';
import { resolveLanguageModel, runClaudeSingleShot } from './sdk-client.js';

/**
 * Before a third fix attempt on a file QA has blocked twice, asks the plan
 * role's model to split that fix into smaller steps. One single-shot call, no
 * tools; null when no file is hot, the plan model fails or its answer isn't usable.
 */
export async function splitHotFix(session: SessionRecord, rounds: QaRoundRecord[]): Promise<QaFixSplit | null> {
  const latest = rounds[rounds.length - 1];
  if (!latest || latest.result !== 'fail') return null;
  const files = hotBlockerFiles(rounds).slice(0, 4);
  if (!files.length) return null;
  const prompt = fixSplitPrompt({
    title: session.title,
    files,
    blockers: latest.blocking,
    planSteps: (session.codingPlan ?? []).map((s) => `${s.title} [${s.status}]`),
  });
  try {
    const { provider, model } = await getRoleModelConfig('plan');
    if (provider === 'claude') {
      return parseFixSplit(await runClaudeSingleShot({ systemPrompt: FIX_SPLIT_INSTRUCTIONS, prompt, model, effort: 'medium' }), latest.pass, files);
    }
    const apiKey = await getApiKey(provider);
    if (apiKey === null) return null;
    const languageModel = await resolveLanguageModel(provider as ApiKeyProvider, model, apiKey);
    const { text } = await generateText({ model: languageModel, system: FIX_SPLIT_INSTRUCTIONS, prompt });
    return parseFixSplit(text, latest.pass, files);
  } catch {
    return null;
  }
}
