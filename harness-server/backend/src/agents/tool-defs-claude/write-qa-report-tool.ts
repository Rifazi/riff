import { tool } from '@anthropic-ai/claude-agent-sdk';
import { writeQaReportSchema, writeQaReportDescription, createWriteQaReportExecute } from '../tool-defs/write-qa-report-tool.js';
import { wrapForClaudeSdk } from './wrap.js';

export function createWriteQaReportToolClaude(sessionInfo: {
  sessionKey: string;
  sessionId: string;
  branch: string;
  requirementsPath: string;
}) {
  return tool(
    'write_qa_report',
    writeQaReportDescription,
    writeQaReportSchema.shape,
    wrapForClaudeSdk(createWriteQaReportExecute(sessionInfo))
  );
}
