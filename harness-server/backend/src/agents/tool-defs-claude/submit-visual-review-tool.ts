import { tool } from '@anthropic-ai/claude-agent-sdk';
import { createSubmitVisualReviewExecute, submitVisualReviewDescription, submitVisualReviewSchema } from '../tool-defs/submit-visual-review-tool.js';
import { wrapForClaudeSdk } from './wrap.js';

export function createSubmitVisualReviewToolClaude(deps: Parameters<typeof createSubmitVisualReviewExecute>[0]) {
  return tool('submit_visual_review', submitVisualReviewDescription, submitVisualReviewSchema.shape, wrapForClaudeSdk(createSubmitVisualReviewExecute(deps)));
}
