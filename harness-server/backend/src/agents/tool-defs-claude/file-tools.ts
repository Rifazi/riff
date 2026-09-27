import { tool } from '@anthropic-ai/claude-agent-sdk';
import {
  readFileSchema,
  readFileDescription,
  writeFileSchema,
  writeFileDescription,
  editFileSchema,
  editFileDescription,
  createFileExecutors,
  type FileToolDeps,
} from '../tool-defs/file-tools.js';
import { wrapForClaudeSdk } from './wrap.js';

export function createFileToolsClaude(deps: FileToolDeps) {
  const { readFileExecute, writeFileExecute, editFileExecute } = createFileExecutors(deps);
  return {
    readFileToolClaude: tool('read_file', readFileDescription, readFileSchema.shape, wrapForClaudeSdk(readFileExecute), {
      annotations: { readOnlyHint: true },
    }),
    writeFileToolClaude: tool('write_file', writeFileDescription, writeFileSchema.shape, wrapForClaudeSdk(writeFileExecute)),
    editFileToolClaude: tool('edit_file', editFileDescription, editFileSchema.shape, wrapForClaudeSdk(editFileExecute)),
  };
}
