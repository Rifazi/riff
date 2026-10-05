import { describe, expect, test } from 'bun:test';

// The agent server has no bun suite of its own, and the repo's only test
// command is `cd frontend && bun test`, so backend logic that is worth
// guarding is tested from here. classification-core.ts is deliberately
// dependency-free (no transformers.js, no settings store, no fs) precisely so
// it can be imported from this suite without downloading a model.
import {
  DEFAULT_MULTI_LABEL_THRESHOLD,
  normalizeLabels,
  normalizeMode,
  normalizeText,
  normalizeThreshold,
  rankScores,
  selectLabels,
} from '../../../harness-server/backend/src/agents/classification-core';

describe('normalizeText', () => {
  test('trims the text it is given', () => {
    expect(normalizeText('  a crash report  ')).toBe('a crash report');
  });

  test('rejects empty, blank or non-string text', () => {
    expect(() => normalizeText('')).toThrow(/non-empty "text"/);
    expect(() => normalizeText('   ')).toThrow(/non-empty "text"/);
    expect(() => normalizeText(undefined)).toThrow(/non-empty "text"/);
    expect(() => normalizeText(42)).toThrow(/non-empty "text"/);
  });
});

describe('normalizeMode', () => {
  // The tool schema leaves `mode` optional and lets this supply the default;
  // a zod `.default()` would make the argument required on the Claude/MCP path.
  test('defaults to single when omitted', () => {
    expect(normalizeMode(undefined)).toBe('single');
    expect(normalizeMode(null)).toBe('single');
  });

  test('passes through the two valid modes', () => {
    expect(normalizeMode('single')).toBe('single');
    expect(normalizeMode('multi')).toBe('multi');
  });

  test('rejects anything else', () => {
    expect(() => normalizeMode('both')).toThrow(/"mode" must be "single" or "multi"/);
  });
});

describe('normalizeLabels', () => {
  test('trims, de-duplicates and keeps the caller order', () => {
    expect(normalizeLabels([' bug report ', 'question', 'bug report', ''])).toEqual(['bug report', 'question']);
  });

  test('needs at least two distinct labels', () => {
    expect(() => normalizeLabels(['bug report', ' bug report '])).toThrow(/at least 2 distinct/);
    expect(() => normalizeLabels(['only one'])).toThrow(/at least 2 distinct/);
  });

  test('rejects a non-array or non-string entries', () => {
    expect(() => normalizeLabels('bug report')).toThrow(/"labels" array/);
    expect(() => normalizeLabels(['bug report', 7])).toThrow(/must all be strings/);
  });
});

describe('normalizeThreshold', () => {
  test('is null in single mode, whatever the caller passed', () => {
    expect(normalizeThreshold(undefined, 'single')).toBeNull();
    expect(normalizeThreshold(0.9, 'single')).toBeNull();
  });

  test('falls back to the documented default in multi mode', () => {
    expect(normalizeThreshold(undefined, 'multi')).toBe(DEFAULT_MULTI_LABEL_THRESHOLD);
    expect(DEFAULT_MULTI_LABEL_THRESHOLD).toBe(0.5);
  });

  test('honours an in-range override, including the boundaries', () => {
    expect(normalizeThreshold(0.8, 'multi')).toBe(0.8);
    expect(normalizeThreshold(0, 'multi')).toBe(0);
    expect(normalizeThreshold(1, 'multi')).toBe(1);
  });

  test('rejects an out-of-range or non-finite override', () => {
    expect(() => normalizeThreshold(1.5, 'multi')).toThrow(/between 0 and 1/);
    expect(() => normalizeThreshold(-0.1, 'multi')).toThrow(/between 0 and 1/);
    expect(() => normalizeThreshold(Number.NaN, 'multi')).toThrow(/between 0 and 1/);
  });
});

describe('rankScores', () => {
  test('pairs the parallel arrays and sorts by descending score', () => {
    expect(rankScores(['a', 'b', 'c'], [0.1, 0.9, 0.5])).toEqual([
      { label: 'b', score: 0.9 },
      { label: 'c', score: 0.5 },
      { label: 'a', score: 0.1 },
    ]);
  });

  test('treats a missing score as zero rather than undefined', () => {
    expect(rankScores(['a', 'b'], [0.4])).toEqual([
      { label: 'a', score: 0.4 },
      { label: 'b', score: 0 },
    ]);
  });
});

describe('selectLabels', () => {
  const ranked = [
    { label: 'a', score: 0.9 },
    { label: 'b', score: 0.5 },
    { label: 'c', score: 0.2 },
  ];

  test('single mode selects exactly the top label', () => {
    expect(selectLabels(ranked, null)).toEqual([{ label: 'a', score: 0.9 }]);
  });

  test('multi mode keeps every label at or above the threshold', () => {
    expect(selectLabels(ranked, 0.5)).toEqual([
      { label: 'a', score: 0.9 },
      { label: 'b', score: 0.5 },
    ]);
  });

  test('multi mode can legitimately select nothing', () => {
    expect(selectLabels(ranked, 0.95)).toEqual([]);
  });
});
