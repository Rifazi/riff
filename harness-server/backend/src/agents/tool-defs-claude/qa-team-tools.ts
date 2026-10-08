import { tool } from '@anthropic-ai/claude-agent-sdk';
import {
  assignQaTeamDescription,
  assignQaTeamSchema,
  createAssignQaTeamExecute,
  createSubmitReviewExecute,
  submitReviewDescription,
  submitReviewSchema,
} from '../tool-defs/qa-team-tools.js';
import { wrapForClaudeSdk } from './wrap.js';

export function createAssignQaTeamToolClaude(deps: { sessionId: string }) {
  return tool('assign_qa_team', assignQaTeamDescription, assignQaTeamSchema.shape, wrapForClaudeSdk(createAssignQaTeamExecute(deps)));
}

export function createSubmitReviewToolClaude(deps: { sessionId: string; memberId: string }) {
  return tool('submit_review', submitReviewDescription, submitReviewSchema.shape, wrapForClaudeSdk(createSubmitReviewExecute(deps)));
}
