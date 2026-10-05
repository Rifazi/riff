import { promises as fs } from 'node:fs';
import path from 'node:path';

// The on-disk half of the classification model cache, kept free of
// transformers.js, config and settings imports (same reason as
// core.ts) so it can be unit-tested against a temp directory
// without downloading a model. classifier.ts owns where the cache lives;
// this module only ever touches the directory it is handed.

/** On-disk state of one curated model inside the classification cache dir. */
export interface ModelCacheStatus {
  id: string;
  downloaded: boolean;
  sizeBytes: number;
}

/**
 * Total size of every file under `dir`, recursively. A missing or unreadable
 * directory counts as 0 — "nothing cached" rather than an error, since this
 * feeds a status display.
 */
export async function directorySize(dir: string): Promise<number> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }

  let total = 0;
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await directorySize(full);
    } else if (entry.isFile()) {
      try {
        total += (await fs.stat(full)).size;
      } catch {
        // A file that vanished mid-walk just doesn't count.
      }
    }
  }
  return total;
}

/**
 * Cache state for each given model id. transformers.js nests a download under
 * its model id ("Xenova/distilbert-base-uncased-mnli/..."), so the id is split
 * into path segments — which also keeps this correct on Windows.
 */
export async function modelCacheStatus(cacheDir: string, modelIds: readonly string[]): Promise<ModelCacheStatus[]> {
  return Promise.all(
    modelIds.map(async (id) => {
      const sizeBytes = await directorySize(path.join(cacheDir, ...id.split('/')));
      return { id, downloaded: sizeBytes > 0, sizeBytes };
    }),
  );
}

/**
 * Deletes every cached model by removing the cache directory, then recreates it
 * empty so the next download has somewhere to land. Errors propagate so the
 * caller can report them with its own wording.
 */
export async function clearModelCache(cacheDir: string): Promise<void> {
  await fs.rm(cacheDir, { recursive: true, force: true });
  await fs.mkdir(cacheDir, { recursive: true });
}
