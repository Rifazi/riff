import { describe, expect, test } from 'bun:test';

import { noteForQaSchema, qaHandoffSection } from '../../../harness-server/backend/src/agents/tool-defs/qa-notes-tool';

// note_for_qa's notes reach QA through this section of its system prompt.
const note = (text: string, from: string | null = null) => ({ id: text, from, text, at: '2026-10-09T00:00:00.000Z' });

describe('qaHandoffSection', () => {
  test('adds nothing when the coding agent left no notes', () => {
    expect(qaHandoffSection([])).toBe('');
  });

  test('lists each note, naming the workstream for an engineer', () => {
    const section = qaHandoffSection([note('Seed data needs `npm run seed`.'), note('Export is CSV only.', 'Reports API')]);

    expect(section).toContain('# Notes from the coding agent');
    expect(section).toContain('- Seed data needs `npm run seed`.');
    expect(section).toContain('- (Reports API) Export is CSV only.');
  });
});

describe('note_for_qa schema', () => {
  test('replace is optional', () => {
    expect(noteForQaSchema.safeParse({ notes: ['x'] }).success).toBe(true);
  });
});
