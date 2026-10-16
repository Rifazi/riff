import { describe, expect, test } from 'bun:test';

import { commitMessageProblem, normalizeCommitMessage } from '../../../harness-server/backend/src/agents/tool-defs/git-tools';

// A rejected commit says exactly why, so the agent fixes it in one try.
describe('commitMessageProblem', () => {
  test('accepts conventional commits, with or without scope and body', () => {
    expect(commitMessageProblem('fix: correct audit region validation status code')).toBeNull();
    expect(commitMessageProblem('feat(api): add region check')).toBeNull();
    expect(commitMessageProblem('fix: short subject\n\nA longer body that explains the change in detail.')).toBeNull();
  });

  test('names the subject length when it is too long', () => {
    const problem = commitMessageProblem(
      'fix: return 400 for unknown audit region instead of 502, fix comparisons httpStatus guard',
    );
    expect(problem).toContain('84 chars, max 72');
  });

  test('names the allowed types when the prefix is wrong', () => {
    expect(commitMessageProblem('Fixed the audit route')).toContain('feat, fix');
    expect(commitMessageProblem('bugfix: audit route')).toContain('type: ');
  });

  test('rejects an empty subject', () => {
    expect(commitMessageProblem('fix:  ')).toContain('empty');
  });
});

// An over-long subject is cut at a word and kept whole in the body, so the
// commit goes through instead of costing a request to retype it.
describe('normalizeCommitMessage', () => {
  test('leaves an acceptable message alone', () => {
    const msg = 'fix: short subject\n\nBody.';
    expect(normalizeCommitMessage(msg)).toEqual({ message: msg, note: null });
    expect(normalizeCommitMessage('Fixed the audit route').note).toBeNull();
  });

  test('cuts a long subject at a word boundary and keeps the full line in the body', () => {
    const subject = 'mention ShipmentTree.tsx/shipmentRow.ts in edi-viewer.md, fix doc comment';
    const { message, note } = normalizeCommitMessage(`docs: ${subject}\n\nMore detail.`);
    const [first, blank, full, blank2, body] = message.split('\n');
    expect(first).toBe('docs: mention ShipmentTree.tsx/shipmentRow.ts in edi-viewer.md, fix doc');
    expect(first.length - 'docs: '.length).toBeLessThanOrEqual(72);
    expect(blank).toBe('');
    expect(full).toBe(`docs: ${subject}`);
    expect(blank2).toBe('');
    expect(body).toBe('More detail.');
    expect(commitMessageProblem(message)).toBeNull();
    expect(note).toContain('73 chars');
  });

  test('wraps a very long original line in the body and hard-cuts a subject with no spaces', () => {
    const long = `feat: ${'word '.repeat(30).trim()}`;
    const { message } = normalizeCommitMessage(long);
    for (const line of message.split('\n').slice(2)) expect(line.length).toBeLessThanOrEqual(100);
    const noSpaces = `fix: ${'a'.repeat(90)}`;
    expect(normalizeCommitMessage(noSpaces).message.split('\n')[0]).toBe(`fix: ${'a'.repeat(72)}`);
  });
});
