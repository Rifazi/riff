import { tool } from 'ai';
import { z } from 'zod';
import type { VisualReviewFinding } from '../../sessions/session.js';

export const submitVisualReviewSchema = z.object({
  verdict: z.enum(['good', 'needs-changes']).describe('"good" = a human can look at these screens and approve them. "needs-changes" = the coder must fix something first.'),
  summary: z.string().min(1).describe('Two or three sentences for the human: what changed on screen and whether it looks right.'),
  findings: z
    .array(
      z.object({
        severity: z.enum(['blocker', 'minor']).describe('blocker = a defect the coder must fix before QA (broken layout, unreadable text, off-theme, missing state). minor = a polish note.'),
        text: z.string().min(1).describe('Where, what is wrong and the fix, in one or two sentences.'),
        screenshot: z.string().optional().describe('The saved file path of the screenshot it is about, as screenshot_app printed it.'),
      }),
    )
    .describe('Empty when the screens are good. Only "blocker" findings hold the branch back.'),
});
export type SubmitVisualReviewInput = z.infer<typeof submitVisualReviewSchema>;

export const submitVisualReviewDescription =
  'Give your verdict on the screens this branch changed. Call it once, after you have looked at them with screenshot_app, and end your turn. ' +
  '"needs-changes" sends the branch back to the coding agent with your blocker findings; "good" shows the screenshots to the human to approve.';

export interface VisualReviewSubmission {
  verdict: 'good' | 'needs-changes';
  summary: string;
  findings: VisualReviewFinding[];
}

export function createSubmitVisualReviewExecute(deps: { onSubmit: (review: VisualReviewSubmission) => void; shotCount: () => number }) {
  return async (input: SubmitVisualReviewInput): Promise<string> => {
    if (deps.shotCount() === 0) throw new Error('Take at least one screenshot with screenshot_app first: a verdict has to come from what you saw.');
    deps.onSubmit(input);
    return 'Recorded. End your turn now.';
  };
}

export function createSubmitVisualReviewTool(deps: Parameters<typeof createSubmitVisualReviewExecute>[0]) {
  return tool({ description: submitVisualReviewDescription, inputSchema: submitVisualReviewSchema, execute: createSubmitVisualReviewExecute(deps) });
}
