'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ExternalLink, GitBranch, GitMerge, GitPullRequest, Loader2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/dev-sessions/api';
import type { DeliveryPlan, SessionRecord } from '@/lib/dev-sessions/types';
import { ConfirmDialog } from './ConfirmDialog';
import { ExternalAnchor } from './ExternalAnchor';
import { ErrorText, Notice } from './PageShell';
import { useRoadmap } from './SplitPanel';

function actionFor(plan: DeliveryPlan): {
  label: string;
  icon: typeof GitMerge;
  confirm: string;
} {
  if (plan.kind === 'merge') {
    return {
      label: `Merge into ${plan.baseBranch}`,
      icon: GitMerge,
      confirm: `Merges ${plan.branch} into ${plan.baseBranch} in your local repo and leaves ${plan.baseBranch} checked out. Nothing is pushed anywhere.`,
    };
  }
  const where = plan.webUrl ?? plan.remoteUrl;
  if (plan.via === 'push-only') {
    return {
      label: `Push to ${plan.remote}`,
      icon: Upload,
      confirm: `Pushes ${plan.branch} to ${plan.remote} (${where}). You then open the merge request yourself from the link.`,
    };
  }
  return {
    label: plan.host === 'github' ? 'Create pull request' : 'Create merge request',
    icon: GitPullRequest,
    confirm: `Pushes ${plan.branch} to ${plan.remote} (${where}) and opens a ${plan.host === 'github' ? 'pull' : 'merge'} request into ${plan.baseBranch}. Your teammates will see it.`,
  };
}

/**
 * The QA tab's last step once QA is reviewed: ship the branch. What that
 * means is detected from the repo — merge locally when there's no remote,
 * otherwise push and open an MR/PR — and always runs on an explicit,
 * confirmed click. A part of a split with parts still to build can instead
 * stay on its branch, and the next part continues on it.
 */
export function DeliveryPanel({ session, qaResult }: { session: SessionRecord; qaResult: string | null }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState<'ship' | 'keep' | null>(null);
  const delivered = session.delivery;
  const kept = delivered?.kind === 'kept';
  const canShip = !delivered || delivered.kind === 'pushed' || kept;

  const { data: roadmap } = useRoadmap(session);
  const partsLeft =
    roadmap?.parts.filter((p) => p.sessionId !== session.id && (p.status === 'in-progress' || p.status === 'not-started'))
      .length ?? 0;
  const canKeep = Boolean(session.splitFrom) && !delivered && partsLeft > 0;
  const preferKeep = canKeep && Boolean(roadmap?.parent.oneBranch);

  const {
    data: plan,
    error: planError,
    isLoading,
  } = useQuery({
    queryKey: ['delivery-plan', session.id, session.branch],
    queryFn: () => api.getDeliveryPlan(session.id),
    enabled: canShip,
  });

  const deliverMutation = useMutation({
    mutationFn: () => api.deliver(session.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['session', session.id] });
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
    },
  });

  const keepMutation = useMutation({
    mutationFn: () => api.keepOnBranch(session.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['session', session.id] });
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
      queryClient.invalidateQueries({ queryKey: ['roadmap'] });
    },
  });

  const action = plan ? actionFor(plan) : null;
  const Icon = action?.icon ?? GitMerge;
  const busy = deliverMutation.isPending || keepMutation.isPending;
  const keepConfirm =
    `Leaves ${session.branch} as it is: nothing is merged or pushed. The next part of this feature continues on ` +
    `${session.branch}, and shipping the last part ships every part together. ${partsLeft} part${partsLeft === 1 ? '' : 's'} left to build.`;

  return (
    <div className="mt-3 rounded-lg border border-border bg-card p-3 space-y-2.5">
      <div className="text-sm font-semibold text-card-foreground">{canKeep ? 'Ship it, or keep building on this branch' : 'Ship it'}</div>

      {delivered && (
        <Notice tone="green">
          <div className="flex items-start gap-2">
            {kept ? <GitBranch className="w-4 h-4 mt-0.5 flex-shrink-0" /> : <CheckCircle2 className="w-4 h-4 mt-0.5 flex-shrink-0" />}
            <div className="space-y-1">
              <div>{delivered.detail}</div>
              {delivered.url && (
                <ExternalAnchor
                  href={delivered.url}
                  className="inline-flex items-center gap-1 font-medium underline break-all"
                >
                  {delivered.url}
                  <ExternalLink className="w-3 h-3 flex-shrink-0" />
                </ExternalAnchor>
              )}
            </div>
          </div>
        </Notice>
      )}

      {canShip && (
        <>
          {isLoading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" />
              Checking how this repo is set up…
            </div>
          )}
          {plan && (
            <p className="text-sm text-muted-foreground">
              {kept && 'Ship it from here only if no later part is on this branch yet: shipping it ships whatever is on it. '}
              {plan.reason}
            </p>
          )}
          {canKeep && (
            <p className="text-sm text-muted-foreground">
              Or keep it on {session.branch} without merging: the next part continues on that branch, and the last part
              ships them all.
            </p>
          )}
          {plan && qaResult && qaResult !== 'pass' && (
            <Notice tone="amber">
              QA&apos;s result was &quot;{qaResult}&quot; — make sure you&apos;re happy with that before shipping.
            </Notice>
          )}
          <ErrorText>
            {(planError as Error | null)?.message ??
              (deliverMutation.error as Error | null)?.message ??
              (keepMutation.error as Error | null)?.message ??
              null}
          </ErrorText>
          <div className={`flex flex-wrap gap-2 ${preferKeep ? 'flex-row-reverse justify-end' : ''}`}>
            {plan && action && (
              <Button
                size="sm"
                variant={preferKeep ? 'outline' : 'default'}
                onClick={() => setConfirming('ship')}
                disabled={busy}
              >
                {deliverMutation.isPending ? <Loader2 className="animate-spin" /> : <Icon />}
                {deliverMutation.isPending ? 'Working…' : action.label}
              </Button>
            )}
            {canKeep && (
              <Button
                size="sm"
                variant={preferKeep ? 'default' : 'outline'}
                onClick={() => setConfirming('keep')}
                disabled={busy}
              >
                {keepMutation.isPending ? <Loader2 className="animate-spin" /> : <GitBranch />}
                {keepMutation.isPending ? 'Working…' : 'Keep on branch for the next part'}
              </Button>
            )}
          </div>
        </>
      )}

      <ConfirmDialog
        open={confirming !== null}
        title={confirming === 'keep' ? 'Keep on branch for the next part?' : action ? `${action.label}?` : ''}
        description={confirming === 'keep' ? keepConfirm : (action?.confirm ?? '')}
        confirmLabel={confirming === 'keep' ? 'Keep on branch' : (action?.label ?? 'Continue')}
        onCancel={() => setConfirming(null)}
        onConfirm={() => {
          const which = confirming;
          setConfirming(null);
          if (which === 'keep') keepMutation.mutate();
          else deliverMutation.mutate();
        }}
      />
    </div>
  );
}
