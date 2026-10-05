import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The filesystem half of the classifier helper's model cache. helpers/classifier/cache.ts
// takes the cache directory as an argument (classifier.ts supplies the real
// one under harness-server/state/), so this runs against a temp dir and never
// touches a real download.
import {
  clearModelCache,
  directorySize,
  modelCacheStatus,
} from '../../../harness-server/backend/src/agents/helpers/classifier/cache';

const MODELS = ['Xenova/distilbert-base-uncased-mnli', 'Xenova/nli-deberta-v3-xsmall', 'Xenova/bart-large-mnli'];

let cacheDir: string;

/** Writes `bytes` bytes at a path relative to the cache dir, creating parents. */
async function writeCachedFile(relative: string, bytes: number): Promise<void> {
  const full = path.join(cacheDir, relative);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, 'x'.repeat(bytes));
}

beforeEach(async () => {
  cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'riff-classification-cache-'));
});

afterEach(async () => {
  await fs.rm(cacheDir, { recursive: true, force: true });
});

describe('directorySize', () => {
  test('sums every file in the tree, however deeply nested', async () => {
    await writeCachedFile('onnx/model_quantized.onnx', 500);
    await writeCachedFile('onnx/nested/deeper/extra.bin', 20);
    await writeCachedFile('tokenizer.json', 30);

    expect(await directorySize(cacheDir)).toBe(550);
  });

  test('treats a missing directory as nothing cached rather than an error', async () => {
    expect(await directorySize(path.join(cacheDir, 'never-downloaded'))).toBe(0);
  });

  test('is 0 for an existing but empty directory', async () => {
    await fs.mkdir(path.join(cacheDir, 'empty'), { recursive: true });

    expect(await directorySize(path.join(cacheDir, 'empty'))).toBe(0);
  });
});

describe('modelCacheStatus', () => {
  test('reports a model as downloaded with its size, from the nested model-id path', async () => {
    // transformers.js nests a download under "<org>/<model>/...".
    await writeCachedFile('Xenova/distilbert-base-uncased-mnli/onnx/model.onnx', 400);
    await writeCachedFile('Xenova/distilbert-base-uncased-mnli/config.json', 100);

    const status = await modelCacheStatus(cacheDir, MODELS);
    const distilbert = status.find((entry) => entry.id === 'Xenova/distilbert-base-uncased-mnli');

    expect(distilbert).toEqual({
      id: 'Xenova/distilbert-base-uncased-mnli',
      downloaded: true,
      sizeBytes: 500,
    });
  });

  test('does not count one model’s files towards another', async () => {
    await writeCachedFile('Xenova/distilbert-base-uncased-mnli/onnx/model.onnx', 400);

    const status = await modelCacheStatus(cacheDir, MODELS);

    expect(status.filter((entry) => entry.downloaded).map((entry) => entry.id)).toEqual([
      'Xenova/distilbert-base-uncased-mnli',
    ]);
    expect(status.find((entry) => entry.id === 'Xenova/bart-large-mnli')).toEqual({
      id: 'Xenova/bart-large-mnli',
      downloaded: false,
      sizeBytes: 0,
    });
  });

  test('returns one entry per requested model, in order, even with no cache dir at all', async () => {
    const status = await modelCacheStatus(path.join(cacheDir, 'does-not-exist'), MODELS);

    expect(status.map((entry) => entry.id)).toEqual(MODELS);
    expect(status.every((entry) => !entry.downloaded && entry.sizeBytes === 0)).toBe(true);
  });
});

describe('clearModelCache', () => {
  test('deletes every cached model, not just one, and leaves the dir ready for reuse', async () => {
    await writeCachedFile('Xenova/distilbert-base-uncased-mnli/onnx/model.onnx', 400);
    await writeCachedFile('Xenova/bart-large-mnli/onnx/model.onnx', 900);

    await clearModelCache(cacheDir);

    expect(await fs.readdir(cacheDir)).toEqual([]);
    const status = await modelCacheStatus(cacheDir, MODELS);
    expect(status.every((entry) => !entry.downloaded && entry.sizeBytes === 0)).toBe(true);
  });

  test('is safe to call when nothing was ever downloaded', async () => {
    const missing = path.join(cacheDir, 'never-created');

    await clearModelCache(missing);

    expect(await fs.readdir(missing)).toEqual([]);
  });
});
