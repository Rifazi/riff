import { tool } from '@anthropic-ai/claude-agent-sdk';
import { noteForQaSchema, noteForQaDescription, createNoteForQaExecute } from '../tool-defs/qa-notes-tool.js';
import { wrapForClaudeSdk } from './wrap.js';

export function createNoteForQaToolClaude(deps: { sessionId: string; from: string | null }) {
  return tool('note_for_qa', noteForQaDescription, noteForQaSchema.shape, wrapForClaudeSdk(createNoteForQaExecute(deps)));
}
