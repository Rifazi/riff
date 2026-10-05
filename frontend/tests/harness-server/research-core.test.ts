import { describe, expect, test } from 'bun:test';

import {
  cleanAnswer,
  delegateSchema,
  formatResults,
  NOTHING_FOUND,
  runDelegation,
  runLimited,
  savedTokens,
  type DelegateTaskResult,
  type HelperRun,
} from '../../../harness-server/backend/src/agents/helpers/research/core';

// The research helper (the delegate tool) exists to save the paid coding agent's context, so these
// pin down that it hands back as little as possible: only the answer, and
// next to nothing when a helper found nothing.

const usage = { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 };
const run = (text: string, readChars = 8000, error: string | null = null): HelperRun => ({ text, error, usage, readChars });
const result = (answer: string | null, error: string | null = null, readChars = 4000): DelegateTaskResult => ({
  answer,
  error,
  readChars,
  localTokens: 0,
});

describe('cleanAnswer', () => {
  test('the NOTHING_FOUND reply, alone or explained, is nothing', () => {
    expect(cleanAnswer(NOTHING_FOUND)).toBeNull();
    expect(cleanAnswer(`  \`${NOTHING_FOUND}\`. `)).toBeNull();
    expect(cleanAnswer(`${NOTHING_FOUND}\nI searched src/ and docs/ but could not find it.`)).toBeNull();
    expect(cleanAnswer('   ')).toBeNull();
  });

  test('a sentinel tacked onto a real answer is dropped, the answer kept', () => {
    expect(cleanAnswer('src/wrap.ts:11\n```ts\nexport function wrap() {\n```\n NOTHING_FOUND')).toBe(
      'src/wrap.ts:11\n```ts\nexport function wrap() {\n```',
    );
  });

  test('reasoning blocks are dropped, closed or not', () => {
    expect(cleanAnswer('<think>let me look</think>\nsrc/a.ts:12 sets it')).toBe('src/a.ts:12 sets it');
    expect(cleanAnswer('src/a.ts:12\n<think>still going')).toBe('src/a.ts:12');
    expect(cleanAnswer('<think>only thinking</think>')).toBeNull();
  });

  test('preamble and sign-off lines are dropped, the answer kept', () => {
    const raw = "Sure! Here's what I found:\nsrc/retry.ts:40 RETRY_DELAY_MS = 5000\n\nLet me know if you need more.";
    expect(cleanAnswer(raw)).toBe('src/retry.ts:40 RETRY_DELAY_MS = 5000');
  });

  test('a long answer is cut at a line break and marked', () => {
    const raw = Array.from({ length: 100 }, (_, i) => `src/file${i}.ts:${i} something`).join('\n');
    const cleaned = cleanAnswer(raw, 300)!;
    expect(cleaned.length).toBeLessThanOrEqual(306);
    expect(cleaned.endsWith('\n[cut]')).toBe(true);
    expect(cleaned.split('\n').slice(0, -1).every((l) => /^src\/file\d+\.ts:\d+ something$/.test(l))).toBe(true);
  });
});

describe('formatResults', () => {
  test('a single answer comes back bare', () => {
    expect(formatResults([result('src/a.ts:3')])).toBe('src/a.ts:3');
  });

  test('nothing found anywhere is one short line', () => {
    const text = formatResults([result(null), result(null), result(null)]);
    expect(text).toStartWith('Nothing found.');
    expect(text.length).toBeLessThan(70);
  });

  test('empty and failed tasks share a line each, after the answers', () => {
    const text = formatResults([
      result('src/a.ts:3'),
      result(null),
      result(null, 'timed out'),
      result(null, 'timed out'),
    ]);
    expect(text).toBe('[1] src/a.ts:3\n\nNothing found: 2.\n\nFailed, do yourself: 3, 4 (timed out).');
  });

  test('a single failure says to do it yourself', () => {
    expect(formatResults([result(null, 'Ollama not reachable')])).toBe(
      'Helper failed (Ollama not reachable). Do this one yourself.',
    );
  });
});

describe('savedTokens', () => {
  test('is what the helpers read minus what came back, in tokens', () => {
    expect(savedTokens([result('x', null, 6000), result(null, null, 2000)], 'x'.repeat(400))).toBe(1900);
  });

  test('never goes below zero', () => {
    expect(savedTokens([result('x', null, 10)], 'x'.repeat(400))).toBe(0);
  });
});

describe('runLimited', () => {
  test('keeps order and never runs more than the limit at once', async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await runLimited([30, 5, 20, 1, 10], 2, async (ms, i) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, ms));
      inFlight -= 1;
      return i;
    });
    expect(out).toEqual([0, 1, 2, 3, 4]);
    expect(peak).toBe(2);
  });
});

describe('runDelegation', () => {
  test('returns only the answers and reports local usage and savings', async () => {
    const prompts: string[] = [];
    const { text, report } = await runDelegation(
      { tasks: [{ task: ' Where is X? ', paths: ['src/'] }, { task: 'Who calls Y?' }] },
      async (prompt) => {
        prompts.push(prompt);
        return prompt.startsWith('Where') ? run('Sure, here it is:\nsrc/x.ts:4') : run(NOTHING_FOUND);
      },
    );
    expect(prompts).toEqual(['Where is X?\n\nStart from: src/', 'Who calls Y?']);
    expect(text).toBe('[1] src/x.ts:4\n\nNothing found: 2.');
    expect(report.tasks).toBe(2);
    expect(report.useful).toBe(1);
    expect(report.usage.input).toBe(2000);
    // 16k characters read, ~30 returned.
    expect(report.savedTokens).toBe(Math.round((16000 - text.length) / 4));
  });

  test('a helper that throws becomes a short failure, not a crash', async () => {
    const { text, report } = await runDelegation({ tasks: [{ task: 'Q' }] }, async () => {
      throw new Error('fetch failed: connect ECONNREFUSED 127.0.0.1:11434');
    });
    expect(text).toBe('Helper failed (Ollama not reachable). Do this one yourself.');
    expect(report.useful).toBe(0);
  });

  test('an empty task is refused', async () => {
    await expect(runDelegation({ tasks: [{ task: '  ' }] }, async () => run('x'))).rejects.toThrow('Task 1 is empty.');
  });
});

describe('delegate schema', () => {
  test('paths is optional, and stays undefined when omitted (MCP needs optional, not default)', () => {
    const parsed = delegateSchema.safeParse({ tasks: [{ task: 'Where is X?' }] });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.tasks[0].paths).toBeUndefined();
  });

  test('takes 1 to 4 tasks', () => {
    expect(delegateSchema.safeParse({ tasks: [] }).success).toBe(false);
    expect(delegateSchema.safeParse({ tasks: Array(5).fill({ task: 'q' }) }).success).toBe(false);
  });
});
