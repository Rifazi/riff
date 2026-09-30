import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hasUncommittedChanges, withRepoLock } from './git.js';

const execFileAsync = promisify(execFile);

// Never let git or gh stop and wait for a password prompt nobody can see —
// fail fast instead, with the error shown in the UI.
const NON_INTERACTIVE_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', GLAB_NO_PROMPT: '1', NO_PROMPT: '1' };

async function run(cmd: string, args: string[], cwd: string, timeoutMs = 120_000): Promise<{ stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { cwd, env: NON_INTERACTIVE_ENV, timeout: timeoutMs, maxBuffer: 10_000_000 });
    return { stdout: String(stdout), stderr: String(stderr) };
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message?: string };
    throw new Error((e.stderr || e.stdout || e.message || String(err)).trim());
  }
}

export type RemoteHost = 'github' | 'gitlab' | 'other';

export type DeliveryPlan =
  // No remote at all: a purely local repo, so "shipping" is merging into the base branch.
  | { kind: 'merge'; branch: string; baseBranch: string; reason: string }
  // Has a remote: push the branch and open a merge/pull request there.
  | {
      kind: 'merge_request';
      branch: string;
      baseBranch: string;
      remote: string;
      remoteUrl: string;
      host: RemoteHost;
      webUrl: string | null;
      // How the request gets created: the GitLab CLI (full Markdown
      // description), GitLab push options (one-line description — git
      // rejects newlines in them), the GitHub CLI, or not at all (push
      // only, the human opens it from the link).
      via: 'glab' | 'gitlab-push-options' | 'gh' | 'push-only';
      reason: string;
    };

export interface DeliveryResult {
  kind: 'merged' | 'merge_request' | 'pushed';
  target: string;
  url: string | null;
  detail: string;
  at: string;
}

/** `git@host:group/repo.git`, `ssh://git@host/group/repo.git`, `https://host/group/repo(.git)` → `https://host/group/repo`. */
export function webUrlForRemote(remoteUrl: string): string | null {
  const url = remoteUrl.trim();
  const scp = /^[\w.-]+@([^:/]+):(.+?)(\.git)?\/?$/.exec(url);
  if (scp) return `https://${scp[1]}/${scp[2]}`;
  const parsed = /^(?:ssh|https?|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(\.git)?\/?$/.exec(url);
  if (parsed) return `https://${parsed[1]}/${parsed[2]}`;
  return null;
}

function hostOf(webUrl: string | null, remoteUrl: string): RemoteHost {
  const host = (webUrl ? new URL(webUrl).hostname : remoteUrl).toLowerCase();
  if (host.includes('github')) return 'github';
  if (host.includes('gitlab')) return 'gitlab';
  return 'other';
}

async function cliReady(cli: 'gh' | 'glab', cwd: string): Promise<boolean> {
  try {
    await run(cli, ['auth', 'status'], cwd, 15_000);
    return true;
  } catch {
    return false;
  }
}

/**
 * Works out how this session's branch should be delivered, from the repo
 * itself: no remote → merge locally; a remote → push and open an MR/PR
 * there, using whatever that host supports without extra setup.
 */
export async function detectDelivery(repoRoot: string, branch: string, baseBranch: string): Promise<DeliveryPlan> {
  const remotes = (await run('git', ['remote'], repoRoot)).stdout.split('\n').map((r) => r.trim()).filter(Boolean);
  if (remotes.length === 0) {
    return { kind: 'merge', branch, baseBranch, reason: `No git remote is configured, so this is a local repo — the branch merges straight into ${baseBranch}.` };
  }

  const remote = remotes.includes('origin') ? 'origin' : remotes[0];
  const remoteUrl = (await run('git', ['remote', 'get-url', remote], repoRoot)).stdout.trim();
  const webUrl = webUrlForRemote(remoteUrl);
  const host = hostOf(webUrl, remoteUrl);
  const where = webUrl ?? remoteUrl;

  if (host === 'gitlab') {
    const glab = await cliReady('glab', repoRoot);
    return {
      kind: 'merge_request', branch, baseBranch, remote, remoteUrl, host, webUrl, via: glab ? 'glab' : 'gitlab-push-options',
      reason: glab
        ? `Remote "${remote}" is GitLab (${where}) — the branch is pushed and a merge request into ${baseBranch} is opened with the GitLab CLI.`
        : `Remote "${remote}" is GitLab (${where}) — the branch is pushed and GitLab opens the merge request into ${baseBranch} as part of the push (install and log in to glab for a fully formatted description).`,
    };
  }
  if (host === 'github') {
    const gh = await cliReady('gh', repoRoot);
    return {
      kind: 'merge_request', branch, baseBranch, remote, remoteUrl, host, webUrl, via: gh ? 'gh' : 'push-only',
      reason: gh
        ? `Remote "${remote}" is GitHub (${where}) — the branch is pushed and a pull request into ${baseBranch} is opened with the GitHub CLI.`
        : `Remote "${remote}" is GitHub (${where}), but the GitHub CLI (gh) isn't installed or logged in — the branch is pushed and you open the pull request from the link.`,
    };
  }
  return {
    kind: 'merge_request', branch, baseBranch, remote, remoteUrl, host, webUrl, via: 'push-only',
    reason: `Remote "${remote}" (${where}) isn't GitHub or GitLab — the branch is pushed and you open the merge request on that host.`,
  };
}

export interface DeliveryText {
  title: string;
  // Full Markdown body.
  description: string;
  // One-line version, for GitLab push options (no newlines allowed).
  summary: string;
}

/**
 * Carries out a plan from detectDelivery. Human-triggered only (the QA
 * tab's delivery button) — no agent tool reaches this.
 */
export async function deliver(repoRoot: string, plan: DeliveryPlan, text: DeliveryText): Promise<DeliveryResult> {
  const at = new Date().toISOString();

  if (plan.kind === 'merge') {
    return withRepoLock(repoRoot, async () => {
      if (await hasUncommittedChanges(repoRoot)) {
        throw new Error(`${repoRoot} has uncommitted changes — commit or stash them before merging.`);
      }
      const current = (await run('git', ['branch', '--show-current'], repoRoot)).stdout.trim();
      await run('git', ['checkout', plan.baseBranch], repoRoot);
      try {
        await run('git', ['merge', '--no-ff', '-m', `Merge branch '${plan.branch}': ${text.title}`, plan.branch], repoRoot);
      } catch (err) {
        await run('git', ['merge', '--abort'], repoRoot).catch(() => undefined);
        if (current) await run('git', ['checkout', current], repoRoot).catch(() => undefined);
        throw new Error(`Merging ${plan.branch} into ${plan.baseBranch} hit conflicts and was aborted — nothing changed. ${(err as Error).message.split('\n')[0]}`);
      }
      const commit = (await run('git', ['rev-parse', '--short', 'HEAD'], repoRoot)).stdout.trim();
      // Left on the base branch deliberately: the next session branches from here.
      return { kind: 'merged', target: plan.baseBranch, url: null, detail: `Merged into ${plan.baseBranch} as ${commit}. ${plan.baseBranch} is now checked out.`, at };
    });
  }

  const pushArgs = ['push', '-u', plan.remote, plan.branch];
  if (plan.via === 'gitlab-push-options') {
    // git rejects push options containing newlines.
    const oneLine = (s: string, max: number) => s.replace(/\s+/g, ' ').trim().slice(0, max);
    pushArgs.push(
      '-o', 'merge_request.create',
      '-o', `merge_request.target=${plan.baseBranch}`,
      '-o', `merge_request.title=${oneLine(text.title, 250)}`,
      '-o', `merge_request.description=${oneLine(text.summary, 2000)}`,
      '-o', 'merge_request.remove_source_branch'
    );
  }
  const push = await run('git', pushArgs, repoRoot);
  const pushOutput = `${push.stdout}\n${push.stderr}`;

  if (plan.via === 'gitlab-push-options') {
    const url = /https?:\/\/\S+\/-\/merge_requests\/\d+/.exec(pushOutput)?.[0] ?? null;
    return {
      kind: 'merge_request',
      target: plan.baseBranch,
      url,
      detail: url ? `Pushed ${plan.branch} and opened a merge request into ${plan.baseBranch}.` : `Pushed ${plan.branch}; GitLab didn't report a merge request URL — check the project.`,
      at,
    };
  }

  if (plan.via === 'glab') {
    let url: string | null;
    try {
      const out = await run('glab', [
        'mr', 'create', '--source-branch', plan.branch, '--target-branch', plan.baseBranch,
        '--title', text.title, '--description', text.description, '--remove-source-branch', '--yes',
      ], repoRoot);
      url = /https?:\/\/\S+\/-\/merge_requests\/\d+/.exec(`${out.stdout}\n${out.stderr}`)?.[0] ?? null;
    } catch (err) {
      if (!/already exists/i.test((err as Error).message)) throw err;
      url = /https?:\/\/\S+\/-\/merge_requests\/\d+/.exec((err as Error).message)?.[0] ?? null;
    }
    return {
      kind: 'merge_request',
      target: plan.baseBranch,
      url,
      detail: url ? `Pushed ${plan.branch} and opened a merge request into ${plan.baseBranch}.` : `Pushed ${plan.branch}; glab didn't report a merge request URL — check the project.`,
      at,
    };
  }

  if (plan.via === 'gh') {
    let url: string;
    try {
      url = (await run('gh', ['pr', 'create', '--base', plan.baseBranch, '--head', plan.branch, '--title', text.title, '--body', text.description], repoRoot)).stdout.trim().split('\n').pop()!;
    } catch (err) {
      if (!/already exists/i.test((err as Error).message)) throw err;
      url = (await run('gh', ['pr', 'view', plan.branch, '--json', 'url', '--jq', '.url'], repoRoot)).stdout.trim();
    }
    return { kind: 'merge_request', target: plan.baseBranch, url, detail: `Pushed ${plan.branch} and opened a pull request into ${plan.baseBranch}.`, at };
  }

  const link = plan.webUrl
    ? plan.host === 'github'
      ? `${plan.webUrl}/compare/${encodeURIComponent(plan.baseBranch)}...${encodeURIComponent(plan.branch)}?expand=1`
      : plan.webUrl
    : null;
  return {
    kind: 'pushed',
    target: plan.baseBranch,
    url: link,
    detail: `Pushed ${plan.branch} to ${plan.remote}. ${link ? 'Open the merge request from the link.' : `Open a merge request into ${plan.baseBranch} on that host.`}`,
    at,
  };
}
