import { promises as fs } from 'node:fs';
import path from 'node:path';

const tails = new Map<string, Promise<unknown>>();

async function lockKey(repoRoot: string): Promise<string> {
  try {
    return await fs.realpath(path.join(repoRoot, 'node_modules'));
  } catch {
    return repoRoot;
  }
}

/**
 * Runs the checks of one checkout one at a time, across sessions: a repo's
 * lint script often runs `npm ci`, which empties node_modules, so two runs
 * at once (lint beside the tests, a retry beside a run still going) delete
 * each other's files and both fail on the install. A team worktree shares
 * the main checkout's node_modules, so it shares its queue too.
 */
export async function runExclusiveCheck<T>(repoRoot: string, run: () => Promise<T>): Promise<T> {
  const key = await lockKey(repoRoot);
  const previous = tails.get(key) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(run);
  const tail = result.catch(() => undefined);
  tails.set(key, tail);
  const cleanup = () => {
    if (tails.get(key) === tail) tails.delete(key);
  };
  tail.then(cleanup);
  return result;
}
