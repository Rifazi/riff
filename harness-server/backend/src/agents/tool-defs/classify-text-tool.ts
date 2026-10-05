import { tool } from 'ai';

import { classifyText, type ClassifyTextResult } from '../classification.js';
import { classifyTextDescription, classifyTextSchema, type ClassifyTextInput } from './classify-text-schema.js';

export { classifyTextDescription, classifyTextSchema, type ClassifyTextInput } from './classify-text-schema.js';

export async function classifyTextExecute(input: ClassifyTextInput): Promise<ClassifyTextResult> {
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
