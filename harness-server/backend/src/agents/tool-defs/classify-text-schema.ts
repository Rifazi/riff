import { z } from 'zod';

import { DEFAULT_MULTI_LABEL_THRESHOLD } from '../classification-core.js';

// Schema + description only, split out of classify-text-tool.ts so a test can
// import and exercise the real schema without pulling in `ai` or the
// transformers.js pipeline behind classification.ts.
export const classifyTextSchema = z.object({
  text: z.string().describe('The text to classify, e.g. a requirement sentence, a commit message, or a log line'),
  labels: z
    .array(z.string())
    .min(2)
    .describe(
      'The candidate labels to rank the text against, e.g. ["bug report", "feature request", "question"] — at least two',
    ),
  // Optional, not `.default('single')`: both engines treat a zod default as a
  // required argument (the Claude/MCP path rejects a call that omits it with
  // "expected nonoptional, received undefined"), so the default lives in
  // classifyText()'s `params.mode ?? 'single'` instead — same as every other
  // optional tool parameter in tool-defs/.
  mode: z
    .enum(['single', 'multi'])
    .optional()
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

export type ClassifyTextInput = z.infer<typeof classifyTextSchema>;

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
