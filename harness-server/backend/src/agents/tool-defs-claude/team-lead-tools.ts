import { tool } from '@anthropic-ai/claude-agent-sdk';
import {
  buildSoloDescription,
  buildSoloSchema,
  createBuildSoloExecute,
  createDropWorkstreamsExecute,
  createMergeWorkstreamExecute,
  createReviewWorkstreamExecute,
  createSendBackWorkstreamExecute,
  createTeamStatusExecute,
  dropWorkstreamsDescription,
  dropWorkstreamsSchema,
  mergeWorkstreamDescription,
  mergeWorkstreamSchema,
  reviewWorkstreamDescription,
  reviewWorkstreamSchema,
  sendBackWorkstreamDescription,
  sendBackWorkstreamSchema,
  teamStatusDescription,
  teamStatusSchema,
  type TeamLeadDeps,
} from '../tool-defs/team-lead-tools.js';
import { wrapForClaudeSdk } from './wrap.js';

export function createTeamLeadToolsClaude(deps: TeamLeadDeps) {
  return [
    tool('team_status', teamStatusDescription, teamStatusSchema.shape, wrapForClaudeSdk(createTeamStatusExecute(deps))),
    tool('review_workstream', reviewWorkstreamDescription, reviewWorkstreamSchema.shape, wrapForClaudeSdk(createReviewWorkstreamExecute(deps))),
    tool('merge_workstream', mergeWorkstreamDescription, mergeWorkstreamSchema.shape, wrapForClaudeSdk(createMergeWorkstreamExecute(deps))),
    tool(
      'send_back_workstream',
      sendBackWorkstreamDescription,
      sendBackWorkstreamSchema.shape,
      wrapForClaudeSdk(createSendBackWorkstreamExecute(deps)),
    ),
    tool('drop_workstreams', dropWorkstreamsDescription, dropWorkstreamsSchema.shape, wrapForClaudeSdk(createDropWorkstreamsExecute(deps))),
  ];
}

export function createBuildSoloToolClaude(deps: { sessionId: string }) {
  return tool('build_solo', buildSoloDescription, buildSoloSchema.shape, wrapForClaudeSdk(createBuildSoloExecute(deps)));
}
