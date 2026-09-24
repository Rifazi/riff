import { tool } from '@anthropic-ai/claude-agent-sdk';
import {
  askMultipleChoiceSchema,
  askMultipleChoiceDescription,
  askMultipleChoiceExecute,
  askQuestionSchema,
  askQuestionDescription,
  askQuestionExecute,
} from '../tool-defs/ask-question-tool.js';
import { wrapForClaudeSdk } from './wrap.js';

export const askMultipleChoiceToolClaude = tool(
  'ask_multiple_choice',
  askMultipleChoiceDescription,
  askMultipleChoiceSchema.shape,
  wrapForClaudeSdk(askMultipleChoiceExecute)
);

export const askQuestionToolClaude = tool(
  'ask_question',
  askQuestionDescription,
  askQuestionSchema.shape,
  wrapForClaudeSdk(askQuestionExecute)
);
