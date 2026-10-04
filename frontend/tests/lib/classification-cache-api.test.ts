import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { api, apiUrl } from '../../src/lib/dev-sessions/api';

type Call = { url: string; method: string; body: string | null };

const originalFetch = globalThis.fetch;
let calls: Call[] = [];

function stubFetch(response: () => Response) {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: typeof input === 'string' ? input : String(input),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : null,
    });
    return Promise.resolve(response());
  }) as typeof fetch;
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('classification cache api client', () => {
  test('reads per-model cache status from the settings route', async () => {
    const models = [
      { id: 'Xenova/distilbert-base-uncased-mnli', downloaded: true, sizeBytes: 71_000_000 },
      { id: 'Xenova/bart-large-mnli', downloaded: false, sizeBytes: 0 },
    ];
    stubFetch(() => new Response(JSON.stringify({ models }), { status: 200 }));

    expect(await api.getClassificationCache()).toEqual({ models });
    expect(calls).toEqual([{ url: apiUrl('/api/settings/classification-cache'), method: 'GET', body: null }]);
  });

  test('clears every cached model with a POST and no body', async () => {
    stubFetch(() => new Response(null, { status: 204 }));

    await api.clearClassificationCache();

    expect(calls).toEqual([{ url: apiUrl('/api/settings/classification-cache/clear'), method: 'POST', body: null }]);
  });

  test('surfaces a failed clear as a rejection instead of resolving quietly', async () => {
    stubFetch(() => new Response('cache busy', { status: 500 }));

    await expect(api.clearClassificationCache()).rejects.toThrow();
  });

  test('saves the selected classification model through the settings patch', async () => {
    stubFetch(
      () => new Response(JSON.stringify({ classification: { model: 'Xenova/bart-large-mnli' } }), { status: 200 }),
    );

    await api.updateSettings({ classification: { model: 'Xenova/bart-large-mnli' } });

    expect(calls[0]?.url).toBe(apiUrl('/api/settings'));
    expect(calls[0]?.method).toBe('POST');
    expect(JSON.parse(calls[0]?.body ?? 'null')).toEqual({
      classification: { model: 'Xenova/bart-large-mnli' },
    });
  });
});
