// A single-slot, lazily-loaded cache keyed by a model id: at most one loaded
// value is held per process, and asking for a different key swaps it. Pulled
// out of classifier.ts so the hot-swap, concurrent-load and failure
// behavior can be unit-tested with a fake loader, instead of needing an actual
// transformers.js pipeline (and a model download) to exercise it.

export interface PipelineCacheOptions<T> {
  /** Loads the value for a key. Called at most once per swap. */
  load: (key: string) => Promise<T>;
  /** Frees a value being swapped out or reset. Best-effort: failures are swallowed. */
  dispose?: (value: T, key: string) => Promise<void> | void;
}

export interface PipelineCache<T> {
  /** The loaded value for `key`, loading (and swapping out any other key) if needed. */
  get(key: string): Promise<T>;
  /** Drops and disposes whatever is loaded, so the next get() loads again. */
  reset(): Promise<void>;
  /** The key currently held, or null when nothing is loaded. */
  loadedKey(): string | null;
}

export function createPipelineCache<T>({ load, dispose }: PipelineCacheOptions<T>): PipelineCache<T> {
  interface Entry {
    key: string;
    value: T;
  }

  let loaded: Entry | null = null;
  /** In-flight load, so concurrent first calls share one download instead of racing. */
  let loading: { key: string; promise: Promise<Entry> } | null = null;

  async function disposeEntry(entry: Entry): Promise<void> {
    try {
      await dispose?.(entry.value, entry.key);
    } catch {
      // Freeing the old value is best-effort — a failure here must not break
      // the call that triggered the swap.
    }
  }

  return {
    async get(key: string): Promise<T> {
      if (loaded?.key === key) return loaded.value;
      if (loading?.key === key) return (await loading.promise).value;

      const promise = load(key).then((value) => ({ key, value }));
      loading = { key, promise };
      try {
        const next = await promise;
        const previous = loaded;
        loaded = next;
        // A failed load leaves the previous value in place, so one bad model
        // selection doesn't take the working one down with it.
        if (previous && previous.key !== next.key) await disposeEntry(previous);
        return next.value;
      } finally {
        if (loading?.promise === promise) loading = null;
      }
    },

    async reset(): Promise<void> {
      const previous = loaded;
      loaded = null;
      loading = null;
      if (previous) await disposeEntry(previous);
    },

    loadedKey(): string | null {
      return loaded?.key ?? null;
    },
  };
}
