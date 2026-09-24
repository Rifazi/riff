import { tool } from '@anthropic-ai/claude-agent-sdk';
import {
  writeRequirementsSchema,
  writeRequirementsDescription,
  createWriteRequirementsExecute,
} from '../tool-defs/write-requirements-tool.js';
import { wrapForClaudeSdk } from './wrap.js';

export function createWriteRequirementsToolClaude(sessionInfo: { sessionKey: string; sessionId: string }) {
  return tool(
    'write_requirements_doc',
    writeRequirementsDescription,
    writeRequirementsSchema.shape,
    wrapForClaudeSdk(createWriteRequirementsExecute(sessionInfo))
  );
}
