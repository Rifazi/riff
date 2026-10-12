import { describe, expect, test } from 'bun:test';

import { hasUnansweredQuestion, parseDecision } from '../../../harness-server/backend/src/agents/coordinator-agent';

// Under auto-drive a "ready" approves the stage, so anything the coordinator
// can't read has to stop for a human instead.
describe('parseDecision', () => {
  test('reads each action', () => {
    expect(parseDecision('{"action":"continue","message":"Go on.","reason":"r"}')).toEqual({
      action: 'continue',
      message: 'Go on.',
      reason: 'r',
    });
    expect(parseDecision('{"action":"ready","reason":"done"}')).toEqual({ action: 'ready', reason: 'done' });
    expect(parseDecision('Sure: {"action":"blocked","reason":"needs keys"}')).toEqual({ action: 'blocked', reason: 'needs keys' });
  });

  test('stops for a human on anything it cannot read', () => {
    expect(parseDecision('looks good to me').action).toBe('blocked');
    expect(parseDecision('{"action":"approve"}').action).toBe('blocked');
    expect(parseDecision('{"action":"continue"}').action).toBe('blocked');
  });
});

describe('hasUnansweredQuestion', () => {
  const entry = (role: 'user' | 'assistant', text: string) => ({ id: text, role, text, timestamp: '2026-10-11T00:00:00.000Z' });

  test('a question in the closing paragraph waits for the human', () => {
    expect(hasUnansweredQuestion([entry('user', 'Build it'), entry('assistant', 'Draft written.\n\nShould exports include archived rows?')])).toBe(true);
  });

  test('a finished summary does not', () => {
    expect(hasUnansweredQuestion([entry('user', 'Build it'), entry('assistant', 'Wrote the requirements doc.')])).toBe(false);
  });
});
