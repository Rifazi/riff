import { tool } from 'ai';
import { z } from 'zod';

export const askMultipleChoiceSchema = z.object({
  question: z.string(),
  options: z.array(z.string()).min(2).max(6),
});
export const askMultipleChoiceDescription =
  "Ask the human a question that has a small set of clear candidate answers, presented as clickable options " +
  "in the UI instead of free text — faster for them than typing. Use this whenever you can enumerate the " +
  "likely answers concretely (e.g. a choice between 2-6 named formats, transports, or a yes/no-style " +
  "decision). For anything more open-ended that needs specifics only the human knows (numbers, names, " +
  "freeform descriptions), call ask_question instead — they can still type a custom answer even when you do " +
  "call this tool, so don't reach for it just to avoid writing a sentence. Call this INSTEAD of asking the " +
  "same question in prose, never both. After calling it, stop your turn and wait for their reply — don't " +
  "guess an answer yourself. Every call must be a genuine question that needs an answer to proceed — never " +
  "call this (or ask_question) to announce that you're waiting or as a substitute for a closing status " +
  "remark. Once you've asked everything you need in this turn, end the turn immediately with no further " +
  "text — do not add a wrap-up or 'waiting on your answer' sentence after the call, the question already " +
  "renders as its own answer box in the UI and a trailing sentence restating that is just noise. If you " +
  "have nothing further to ask, simply end your turn with no tool call and no text at all.";

/**
 * Pure signal to the UI — no side effects, nothing to verify or persist.
 * The question/options live entirely in the tool_call's own input; the
 * execute result just needs to read sensibly to the model so it knows the
 * question has been posed and it should stop, not that anything failed.
 */
export async function askMultipleChoiceExecute({
  question,
  options,
}: z.infer<typeof askMultipleChoiceSchema>): Promise<string> {
  return `Presented to the human: "${question}" with options [${options.join(', ')}]. Wait for their reply — do not guess or restate the question in your own text.`;
}

export const askMultipleChoiceTool = tool({
  description: askMultipleChoiceDescription,
  inputSchema: askMultipleChoiceSchema,
  execute: askMultipleChoiceExecute,
});

export const askQuestionSchema = z.object({
  question: z.string(),
});
export const askQuestionDescription =
  "Ask the human a single open-ended question that needs their own specifics — a name, an id, a number, a " +
  "freeform description — and can't be reduced to a small set of candidate answers (use ask_multiple_choice " +
  "instead when it can). Renders as its own answer box in the UI, the same way ask_multiple_choice renders " +
  "its own set of buttons, instead of being buried in prose the human has to answer by typing in the general " +
  "chat box. Call this INSTEAD of asking the same question in your response text, never both. Ask several by " +
  "calling this (or ask_multiple_choice) more than once in the same turn — every question asked this way " +
  "since the human's last message is presented together and answered together. After calling it, stop your " +
  "turn and wait for their reply — don't guess an answer yourself. Every call must be a genuine question that " +
  "needs an answer to proceed — never call this (or ask_multiple_choice) to announce that you're waiting, to " +
  "restate a question you already asked, or as a substitute for a closing status remark. Once you've asked " +
  "everything you need in this turn, end the turn immediately with no further text — do not add a wrap-up or " +
  "'waiting on your answer' sentence after the call, the question already renders as its own answer box in " +
  "the UI and a trailing sentence restating that is just noise. If you have nothing further to ask, simply " +
  "end your turn with no tool call and no text at all — that is the correct way to wait, not a 'question' " +
  "whose content is that you're waiting.";

export async function askQuestionExecute({ question }: z.infer<typeof askQuestionSchema>): Promise<string> {
  return `Presented to the human: "${question}". Wait for their reply — do not guess or restate the question in your own text.`;
}

export const askQuestionTool = tool({
  description: askQuestionDescription,
  inputSchema: askQuestionSchema,
  execute: askQuestionExecute,
});
