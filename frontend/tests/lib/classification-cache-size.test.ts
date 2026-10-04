import { describe, expect, test } from 'bun:test';

import { formatBytes, totalCachedBytes } from '../../src/components/DevSessions/ClassificationToolSettings/cache-size';

describe('classification cache sizes', () => {
  test('shows nothing cached as 0 B rather than NaN', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(-1)).toBe('0 B');
    expect(formatBytes(Number.NaN)).toBe('0 B');
  });

  test('uses binary units with one decimal below 100', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(74_973_184)).toBe('71.5 MB');
  });

  test('drops the decimal once the number is already big', () => {
    expect(formatBytes(421_527_552)).toBe('402 MB');
  });

  test('caps at gigabytes instead of inventing a unit', () => {
    expect(formatBytes(3 * 1024 ** 4)).toBe('3072 GB');
  });

  test('totals only the models actually on disk', () => {
    expect(
      totalCachedBytes([
        { id: 'Xenova/distilbert-base-uncased-mnli', downloaded: true, sizeBytes: 1024 },
        { id: 'Xenova/nli-deberta-v3-xsmall', downloaded: false, sizeBytes: 999 },
        { id: 'Xenova/bart-large-mnli', downloaded: true, sizeBytes: 2048 },
      ]),
    ).toBe(3072);
  });

  test('an empty cache totals zero', () => {
    expect(totalCachedBytes([])).toBe(0);
  });
});
