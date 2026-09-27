'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ExternalLink, GitMerge, GitPullRequest, Loader2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/dev-sessions/api';
import type { DeliveryPlan, SessionRecord } from '@/lib/dev-sessions/types';
import { ConfirmDialog } from './ConfirmDialog';
import { ExternalAnchor } from './ExternalAnchor';
import { ErrorText, Notice } from './PageShell';

function actionFor(plan: DeliveryPlan): { label: string; icon: typeof GitMerge; confirm: string } {
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
 * confirmed click.
 */
export function DeliveryPanel({ session, qaResult }: { session: SessionRecord; qaResult: string | null }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const delivered = session.delivery;
  const canShip = !delivered || delivered.kind === 'pushed';

  const { data: plan, error: planError, isLoading } = useQuery({
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

  const action = plan ? actionFor(plan) : null;
  const Icon = action?.icon ?? GitMerge;

  return (
    <div className="mt-3 rounded-lg border border-gray-200 bg-white p-3 space-y-2.5">
      <div className="text-sm font-semibold text-gray-900">Ship it</div>

      {delivered && (
        <Notice tone="green">
          <div className="flex items-start gap-2">
            <CheckCircle2 className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <div className="space-y-1">
              <div>{delivered.detail}</div>
              {delivered.url && (
                <ExternalAnchor href={delivered.url} className="inline-flex items-center gap-1 font-medium underline break-all">
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
            <div className="flex items-center gap-2 text-sm text-gray-500">
              <Loader2 className="w-4 h-4 animate-spin" />
              Checking how this repo is set up…
            </div>
          )}
          {plan && <p className="text-sm text-gray-600">{plan.reason}</p>}
          {plan && qaResult && qaResult !== 'pass' && (
            <Notice tone="amber">QA&apos;s result was &quot;{qaResult}&quot; — make sure you&apos;re happy with that before shipping.</Notice>
          )}
          <ErrorText>{(planError as Error | null)?.message ?? (deliverMutation.error as Error | null)?.message ?? null}</ErrorText>
          {plan && action && (
            <Button size="sm" variant="blue" onClick={() => setConfirming(true)} disabled={deliverMutation.isPending}>
              {deliverMutation.isPending ? <Loader2 className="animate-spin" /> : <Icon />}
              {deliverMutation.isPending ? 'Working…' : action.label}
            </Button>
          )}
        </>
      )}

      <ConfirmDialog
        open={confirming}
        title={action ? `${action.label}?` : ''}
        description={action?.confirm ?? ''}
        confirmLabel={action?.label ?? 'Continue'}
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          deliverMutation.mutate();
        }}
      />
    </div>
  );
}
