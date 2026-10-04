import { tool } from '@anthropic-ai/claude-agent-sdk';
import type { CodingTeamKind } from '../../sessions/session.js';
import { assignTeamSchema, assignTeamDescription, createAssignTeamExecute } from '../tool-defs/assign-team-tool.js';
import { wrapForClaudeSdk } from './wrap.js';

export function createAssignTeamToolClaude(deps: { sessionId: string; repoRoot: string; kind: CodingTeamKind }) {
  return tool('assign_team', assignTeamDescription, assignTeamSchema.shape, wrapForClaudeSdk(createAssignTeamExecute(deps)));
}
