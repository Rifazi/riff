import { tool } from 'ai';
import { z } from 'zod';
import { classifyText, DEFAULT_MULTI_LABEL_THRESHOLD, type ClassifyTextResult } from '../classification.js';

export const classifyTextSchema = z.object({
  text: z.string().describe('The text to classify, e.g. a requirement sentence, a commit message, or a log line'),
  labels: z
    .array(z.string())
    .min(2)
    .describe(
      'The candidate labels to rank the text against, e.g. ["bug report", "feature request", "question"] — at least two',
    ),
  mode: z
    .enum(['single', 'multi'])
    .default('single')
    .describe(
      '"single" (default): return the one best-fitting label. "multi": return every label that fits, scored independently.',
    ),
  threshold: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe(
      `Multi mode only: the minimum score a label needs to be returned (0-1, default ${DEFAULT_MULTI_LABEL_THRESHOLD}). Ignored in single mode.`,
    ),
});

export const classifyTextDescription =
  'Classify a piece of text against candidate labels YOU supply, using a small NLI model that runs entirely ' +
  'on this machine — no cloud call, no API cost, no per-call latency beyond local inference (the model is ' +
  'downloaded once, cached on disk, and then reused for the rest of the process). Use it to offload the kind ' +
  'of small "which of these buckets does this fall into?" judgement that would otherwise burn a turn of your ' +
  'own reasoning: triaging a QA finding by severity, tagging a requirement by area, deciding whether a doc ' +
  'section is relevant to a query, sorting a list of items into known categories. Set mode to "single" (the ' +
  'default) when exactly one label applies and you want the best one; set it to "multi" when several labels ' +
  'can apply at once, optionally with a threshold to tighten or loosen what counts as a match. It only RANKS ' +
  'the labels you give it — it cannot invent labels, write prose, summarize, or make open-ended decisions, so ' +
  'do not reach for it in place of your own reasoning on anything that is not a closed-set choice. Results ' +
  'include a confidence score per label plus the scores of the labels that did not win, so you can tell a ' +
  'confident classification from a coin flip and fall back to your own judgement when the scores are close.';

export async function classifyTextExecute(input: z.infer<typeof classifyTextSchema>): Promise<ClassifyTextResult> {
  // Everything that can go wrong here — bad input, a model that fails to
  // download or load, an inference or cache error — throws out of
  // classifyText() with a human-readable message. Per the tool error
  // convention both engines turn that into a tool-level error the model
  // sees and can recover from, rather than failing the turn, so there is
  // deliberately no try/catch in this tool.
  return classifyText({
    text: input.text,
    labels: input.labels,
    mode: input.mode,
    threshold: input.threshold,
  });
}

export const classifyTextTool = tool({
  description: classifyTextDescription,
  inputSchema: classifyTextSchema,
  execute: classifyTextExecute,
});
