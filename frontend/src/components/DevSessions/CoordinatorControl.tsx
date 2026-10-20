'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/dev-sessions/api';
import type { SessionRecord } from '@/lib/dev-sessions/types';
import { COORDINATOR_PERSONA } from '@/lib/dev-sessions/agents';

/**
 * Per-session toggle for Bridget, the coordinator — off by default. With it
 * on she drives the session to a merge request: each stage's tab starts her
 * (useCoordinatorAutoRun), and she approves a finished stage herself unless
 * something needs the human (routes/coordinator.ts on the server).
 */
export function CoordinatorControl({ session, streaming }: { session: SessionRecord; streaming: boolean }) {
  const queryClient = useQueryClient();

  const toggleMutation = useMutation({
    mutationFn: (enabled: boolean) => api.toggleCoordinator(session.id, enabled),
    onSuccess: (updated) => {
      queryClient.setQueryData(['session', session.id], updated);
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
    },
  });

  const enabled = session.coordinatorEnabled;

  return (
    <label
      className="flex items-center gap-2 text-sm text-foreground cursor-pointer"
      title={COORDINATOR_PERSONA.fullName}
    >
      <Switch
        checked={enabled}
        disabled={toggleMutation.isPending}
        onCheckedChange={(checked) => toggleMutation.mutate(checked)}
      />
      <span className="font-medium">Auto-drive with {COORDINATOR_PERSONA.name}</span>
      <span className="text-muted-foreground hidden lg:inline">
        {streaming && enabled
          ? `— ${COORDINATOR_PERSONA.name} is driving this stage; turn off to stop after this turn`
          : streaming
            ? `— ${COORDINATOR_PERSONA.name} takes over when this turn ends`
            : enabled
              ? '— approves each stage and opens the MR, stopping for questions or issues'
              : '— you drive every message'}
      </span>
    </label>
  );
}
