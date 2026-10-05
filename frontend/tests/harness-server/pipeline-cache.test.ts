import { describe, expect, test } from 'bun:test';

// The in-memory singleton behind classify_text: loaded once per process, and
// hot-swapped when the model selected in Settings → Dev Agents changes. The
// loader is injected, so this exercises the swap without a model download.
import { createPipelineCache } from '../../../harness-server/backend/src/agents/pipeline-cache';

interface FakePipeline {
  model: string;
}

/** A loader that records every call and resolves to a value tagged with its key. */
function recordingLoader() {
  const calls: string[] = [];
  const load = async (key: string): Promise<FakePipeline> => {
    calls.push(key);
    return { model: key };
  };
  return { calls, load };
}

describe('createPipelineCache', () => {
  test('loads once and reuses the same value for repeated calls', async () => {
    const { calls, load } = recordingLoader();
    const cache = createPipelineCache<FakePipeline>({ load });

    const first = await cache.get('model-a');
    const second = await cache.get('model-a');

    expect(calls).toEqual(['model-a']);
    expect(second).toBe(first);
    expect(cache.loadedKey()).toBe('model-a');
  });

  test('concurrent calls for the same key share one load', async () => {
    const { calls, load } = recordingLoader();
    const cache = createPipelineCache<FakePipeline>({ load });

    const [first, second] = await Promise.all([cache.get('model-a'), cache.get('model-a')]);

    expect(calls).toEqual(['model-a']);
    expect(second).toBe(first);
  });

  test('swaps to a new key and disposes the value it replaced', async () => {
    const { calls, load } = recordingLoader();
    const disposed: string[] = [];
    const cache = createPipelineCache<FakePipeline>({
      load,
      dispose: (value) => {
        disposed.push(value.model);
      },
    });

    await cache.get('model-a');
    const swapped = await cache.get('model-b');

    expect(calls).toEqual(['model-a', 'model-b']);
    expect(swapped.model).toBe('model-b');
    expect(disposed).toEqual(['model-a']);
    expect(cache.loadedKey()).toBe('model-b');
  });

  test('swapping back after a swap reloads rather than returning a stale value', async () => {
    const { calls, load } = recordingLoader();
    const cache = createPipelineCache<FakePipeline>({ load });

    await cache.get('model-a');
    await cache.get('model-b');
    const back = await cache.get('model-a');

    expect(calls).toEqual(['model-a', 'model-b', 'model-a']);
    expect(back.model).toBe('model-a');
  });

  test('a failing load surfaces its error and leaves the working value in place', async () => {
    const cache = createPipelineCache<FakePipeline>({
      load: async (key) => {
        if (key === 'broken') throw new Error('could not load the model');
        return { model: key };
      },
    });

    await cache.get('model-a');
    await expect(cache.get('broken')).rejects.toThrow('could not load the model');

    expect(cache.loadedKey()).toBe('model-a');
    // And the next good call is served without reloading.
    expect((await cache.get('model-a')).model).toBe('model-a');
  });

  test('a failed load can be retried', async () => {
    let attempts = 0;
    const cache = createPipelineCache<FakePipeline>({
      load: async (key) => {
        attempts += 1;
        if (attempts === 1) throw new Error('network blip');
        return { model: key };
      },
    });

    await expect(cache.get('model-a')).rejects.toThrow('network blip');
    expect(cache.loadedKey()).toBeNull();

    expect((await cache.get('model-a')).model).toBe('model-a');
    expect(attempts).toBe(2);
  });

  test('reset disposes what is loaded so the next call loads again', async () => {
    const { calls, load } = recordingLoader();
    const disposed: string[] = [];
    const cache = createPipelineCache<FakePipeline>({
      load,
      dispose: (value) => {
        disposed.push(value.model);
      },
    });

    await cache.get('model-a');
    await cache.reset();

    expect(disposed).toEqual(['model-a']);
    expect(cache.loadedKey()).toBeNull();

    await cache.get('model-a');
    expect(calls).toEqual(['model-a', 'model-a']);
  });

  test('reset on an empty cache does nothing', async () => {
    const disposed: string[] = [];
    const cache = createPipelineCache<FakePipeline>({
      load: async (key) => ({ model: key }),
      dispose: (value) => {
        disposed.push(value.model);
      },
    });

    await cache.reset();

    expect(disposed).toEqual([]);
    expect(cache.loadedKey()).toBeNull();
  });

  test('a dispose that throws does not break the call that triggered the swap', async () => {
    const { load } = recordingLoader();
    const cache = createPipelineCache<FakePipeline>({
      load,
      dispose: () => {
        throw new Error('freeing the ONNX session failed');
      },
    });

    await cache.get('model-a');

    expect((await cache.get('model-b')).model).toBe('model-b');
    expect(cache.loadedKey()).toBe('model-b');
  });
});
