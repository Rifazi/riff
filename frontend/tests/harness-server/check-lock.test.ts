import { describe, expect, it } from 'bun:test';
import { runExclusiveCheck } from '../../../harness-server/backend/src/repo/check-lock';

describe('runExclusiveCheck', () => {
  it('never overlaps runs on one checkout, even when one fails', async () => {
    let active = 0;
    let peak = 0;
    const run = (fail: boolean) => async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 15));
      active--;
      if (fail) throw new Error('lint failed');
      return 'ok';
    };
    const results = await Promise.allSettled([
      runExclusiveCheck('/tmp/no-such-repo', run(true)),
      runExclusiveCheck('/tmp/no-such-repo', run(false)),
      runExclusiveCheck('/tmp/no-such-repo', run(false)),
    ]);
    expect(peak).toBe(1);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled', 'fulfilled']);
  });

  it('lets different checkouts run together', async () => {
    let active = 0;
    let peak = 0;
    const run = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 15));
      active--;
    };
    await Promise.all([runExclusiveCheck('/tmp/repo-a', run), runExclusiveCheck('/tmp/repo-b', run)]);
    expect(peak).toBe(2);
  });
});
