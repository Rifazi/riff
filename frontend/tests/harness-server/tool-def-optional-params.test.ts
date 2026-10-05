import { describe, expect, test } from 'bun:test';

import { normalizeMode } from '../../../harness-server/backend/src/agents/helpers/classifier/core';
import { classifyTextSchema } from '../../../harness-server/backend/src/agents/helpers/classifier/schema';

// Guards a defect that shipped once: classify_text declared
// `mode: z.enum([...]).default('single')`, and a zod default makes the
// argument *required* on the Claude-Agent-SDK/MCP path — calling the tool
// without `mode` failed with "expected nonoptional, received undefined",
// contradicting the tool's own description and docs. Optional tool parameters
// must be `.optional()`, with the default applied in the execute path
// (classifyText()'s `params.mode ?? 'single'`, i.e. normalizeMode below).
//
// These assert on the real schema object, not on the source text, so they
// survive reordering/renaming and say nothing about what other tools may do.
const call = (input: unknown) => classifyTextSchema.safeParse(input);

const minimal = { text: 'The totals round to the wrong number of decimals.', labels: ['bug report', 'question'] };

describe('classify_text schema: optional parameters', () => {
  test('a call that omits mode and threshold is accepted', () => {
    const result = call(minimal);

    expect(result.success).toBe(true);
  });

  test('omitting mode leaves it undefined rather than parsing to a default', () => {
    // A zod `.default('single')` would both populate this and make the
    // parameter required over MCP — undefined here is the point.
    const result = call(minimal);

    expect(result.success && result.data.mode).toBeUndefined();
    expect(result.success && 'mode' in result.data).toBe(false);
  });

  test('the single-mode default is applied by the execute path instead', () => {
    expect(normalizeMode(undefined)).toBe('single');
  });

  test('omitting threshold leaves it undefined rather than parsing to a default', () => {
    const result = call(minimal);

    expect(result.success && result.data.threshold).toBeUndefined();
    expect(result.success && 'threshold' in result.data).toBe(false);
  });
});

describe('classify_text schema: accepted and rejected input', () => {
  test('both modes are accepted when given explicitly', () => {
    expect(call({ ...minimal, mode: 'single' }).success).toBe(true);
    expect(call({ ...minimal, mode: 'multi' }).success).toBe(true);
  });

  test('an unknown mode is rejected', () => {
    expect(call({ ...minimal, mode: 'maybe' }).success).toBe(false);
  });

  test('text and labels are required', () => {
    expect(call({ labels: minimal.labels }).success).toBe(false);
    expect(call({ text: minimal.text }).success).toBe(false);
  });

  test('fewer than two labels is rejected', () => {
    expect(call({ ...minimal, labels: ['bug report'] }).success).toBe(false);
    expect(call({ ...minimal, labels: [] }).success).toBe(false);
  });

  test('a threshold inside 0-1 is accepted and one outside it is rejected', () => {
    expect(call({ ...minimal, mode: 'multi', threshold: 0 }).success).toBe(true);
    expect(call({ ...minimal, mode: 'multi', threshold: 0.75 }).success).toBe(true);
    expect(call({ ...minimal, mode: 'multi', threshold: 1 }).success).toBe(true);
    expect(call({ ...minimal, mode: 'multi', threshold: 1.5 }).success).toBe(false);
    expect(call({ ...minimal, mode: 'multi', threshold: -0.1 }).success).toBe(false);
  });
});
