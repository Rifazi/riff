import { tool } from '@anthropic-ai/claude-agent-sdk';
import { reportWorkstreamSchema, reportWorkstreamDescription, createReportWorkstreamExecute } from '../tool-defs/workstream-report-tool.js';
import { wrapForClaudeSdk } from './wrap.js';

export function createReportWorkstreamToolClaude(deps: { sessionId: string; memberId: string }) {
  return tool('report_workstream', reportWorkstreamDescription, reportWorkstreamSchema.shape, wrapForClaudeSdk(createReportWorkstreamExecute(deps)));
}
