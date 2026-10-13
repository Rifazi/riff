import { simpleGit } from 'simple-git';
import { baseBranchFor, type AppConfig } from '../apps/apps.js';
import { checkoutExistingBranch, GitPreconditionError, hasUncommittedChanges } from '../repo/git.js';
import type { SessionRecord } from './session.js';
import { getSession, listSessions, mutateSession, updateSession } from './session-store.js';
import { buildSplitRoadmap } from './split-roadmap.js';

// A split feature's parts can be built on one branch (one ticket, one MR)
// instead of each shipping into the base branch on its own. After QA, a part
// is "kept" on its branch rather than shipped; the parent records that
// branch, and the next part to start coding checks it out instead of
// branching off the base branch. Whichever part ships it last ships them all.

type Delivery = SessionRecord['delivery'];

/** Merged or sent off as an MR — fixes on the branch no longer reach anything. A push alone or a kept part isn't. */
export function isShipped(delivery: Delivery): boolean {
  return Boolean(delivery && delivery.kind !== 'pushed' && delivery.kind !== 'kept');
}

/** What this session's diffs, QA and handoffs compare against: where its part of a shared branch started, else the base branch. */
export function diffBaseFor(session: Pick<SessionRecord, 'branchBase'>, app: AppConfig): string {
  return session.branchBase ?? baseBranchFor(app);
}

async function splitParent(session: SessionRecord): Promise<SessionRecord | null> {
  if (session.splitInto.length > 0) return session;
  return session.splitFrom ? getSession(session.splitFrom.sessionId) : null;
}

/** The split's shared branch a part should continue on when it starts coding, or null to branch off the base branch. */
export async function sharedBranchFor(session: SessionRecord): Promise<string | null> {
  if (!session.splitFrom || session.branch) return null;
  return (await getSession(session.splitFrom.sessionId))?.splitBranch ?? null;
}

/**
 * Checks out an existing shared branch for a part starting to code. Returns
 * the commit its work starts from (SessionRecord.branchBase).
 */
export async function checkoutSharedBranch(repoRoot: string, branch: string): Promise<string> {
  if (await hasUncommittedChanges(repoRoot)) {
    throw new GitPreconditionError(`${repoRoot} has uncommitted changes. Commit or stash them before continuing on ${branch}.`);
  }
  await checkoutExistingBranch(repoRoot, branch);
  return (await simpleGit(repoRoot).revparse(['HEAD'])).trim();
}

/** How many other parts of this session's split are still to build (not shipped, kept or dropped). */
export async function partsRemaining(session: SessionRecord): Promise<number> {
  const parent = await splitParent(session);
  if (!parent || parent === session) return 0;
  const roadmap = buildSplitRoadmap(parent, await listSessions());
  return roadmap.parts.filter((p) => p.sessionId !== session.id && (p.status === 'in-progress' || p.status === 'not-started')).length;
}

/** Whether Bridget should keep a passed part on its branch instead of shipping it. */
export async function shouldKeepOnBranch(session: SessionRecord): Promise<boolean> {
  const parent = session.splitFrom ? await getSession(session.splitFrom.sessionId) : null;
  if (!parent || !session.branch) return false;
  const oneBranch = parent.splitOneBranch || (parent.splitBranch !== null && parent.splitBranch === session.branch);
  return oneBranch && (await partsRemaining(session)) > 0;
}

/** Leaves a reviewed part on its branch for the next part to continue on, instead of shipping it. */
export async function keepOnBranch(session: SessionRecord): Promise<SessionRecord> {
  const branch = session.branch;
  if (!branch) throw new Error('no branch to keep yet');
  if (!session.splitFrom) throw new Error('only a part of a split feature can be kept on its branch for the next part');
  if (session.qaStatus !== 'reviewed') throw new Error('mark QA reviewed before keeping the branch');
  if (session.delivery) throw new Error(`already ${session.delivery.kind === 'kept' ? 'kept' : 'delivered'}: ${session.delivery.detail}`);

  await mutateSession(session.splitFrom.sessionId, (parent) => {
    parent.splitBranch = branch;
  });
  return updateSession(session.id, {
    delivery: {
      kind: 'kept',
      target: branch,
      url: null,
      detail: `Kept on ${branch}, not merged. The next part continues on this branch, and it all ships together.`,
      at: new Date().toISOString(),
    },
  });
}

/**
 * After a shared branch ships, the parts kept on it record the same
 * delivery, and later parts branch off the base branch again.
 */
export async function recordSharedBranchShipped(session: SessionRecord): Promise<void> {
  const delivery = session.delivery;
  const parent = await splitParent(session);
  if (!delivery || !session.branch || !parent || parent === session) return;
  for (const id of parent.splitInto) {
    if (id === session.id) continue;
    const part = await getSession(id);
    if (part?.delivery?.kind === 'kept' && part.delivery.target === session.branch) {
      await updateSession(id, { delivery: { ...delivery, detail: `Shipped with "${session.title}": ${delivery.detail}` } });
    }
  }
  if (parent.splitBranch === session.branch) {
    await mutateSession(parent.id, (p) => {
      p.splitBranch = null;
    });
  }
}

/** The human's settings for a split's branch: build on one branch, or stop continuing on the kept one. */
export async function updateSplitBranchSettings(
  session: SessionRecord,
  changes: { oneBranch?: boolean; clearBranch?: boolean },
): Promise<SessionRecord> {
  const parent = await splitParent(session);
  if (!parent) throw new Error('this session is not part of a split');
  return mutateSession(parent.id, (p) => {
    if (changes.oneBranch !== undefined) p.splitOneBranch = changes.oneBranch;
    if (changes.clearBranch) p.splitBranch = null;
  });
}
