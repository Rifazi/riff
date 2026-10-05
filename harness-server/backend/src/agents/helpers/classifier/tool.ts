import { tool } from 'ai';

import { classifyText, type ClassifyTextResult } from './classifier.js';
import { classifyTextDescription, classifyTextSchema, type ClassifyTextInput } from './schema.js';
import { reportHelperRun, type HelperContext } from '../helper.js';

export { classifyTextDescription, classifyTextSchema, type ClassifyTextInput } from './schema.js';

/** "bug report (0.91)" — the picked labels, or what scored highest when none cleared the threshold. */
function pickedLine(result: ClassifyTextResult): string {
  const show = (l: { label: string; score: number }) => `${l.label} (${l.score.toFixed(2)})`;
  if (result.selected.length) return result.selected.map(show).join(', ');
  return `no label cleared ${result.threshold}; top was ${result.allScores[0] ? show(result.allScores[0]) : 'none'}`;
}

/**
 * `context` reports each run like every local helper (helpers/helper.ts):
 * to the usage log and as a chat entry. Without it (tests, one-off calls)
 * the tool just classifies.
 */
export function createClassifyTextExecute(context?: HelperContext) {
  return async (input: ClassifyTextInput): Promise<ClassifyTextResult> => {
    // Everything that can go wrong here — bad input, a model that fails to
    // download or load, an inference or cache error — throws out of
    // classifyText() with a human-readable message. Per the tool error
    // convention both engines turn that into a tool-level error the model
    // sees and can recover from, rather than failing the turn, so there is
    // deliberately no try/catch in this tool.
    const result = await classifyText({
      text: input.text,
      labels: input.labels,
      mode: input.mode,
      threshold: input.threshold,
    });
    await reportHelperRun(
      context,
      { helper: 'classifier', model: result.model, tasks: 1, useful: result.selected.length ? 1 : 0, savedTokens: null },
      `Classifier (${result.model}): ${pickedLine(result)} from ${result.allScores.length} labels`,
    );
    return result;
  };
}

export function createClassifyTextTool(context?: HelperContext) {
  return tool({
    description: classifyTextDescription,
    inputSchema: classifyTextSchema,
    execute: createClassifyTextExecute(context),
  });
}
