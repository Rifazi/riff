'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/dev-sessions/api';
import type { SessionRecord } from '@/lib/dev-sessions/types';
import { COORDINATOR_PERSONA } from '@/lib/dev-sessions/agents';

/**
 * Per-session opt-in toggle for the coordinator — off by default. Turning it
 * on doesn't do anything by itself; each stage auto-starts a
 * /coordinator/run when it mounts with an empty transcript and this flag on.
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
    <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer" title={COORDINATOR_PERSONA.fullName}>
      <Switch
        checked={enabled}
        disabled={toggleMutation.isPending || streaming}
        onCheckedChange={(checked) => toggleMutation.mutate(checked)}
      />
      <span className="font-medium">Auto-drive with {COORDINATOR_PERSONA.name}</span>
      <span className="text-gray-500 hidden lg:inline">
        {streaming && enabled
          ? `— ${COORDINATOR_PERSONA.name} is driving this stage…`
          : enabled
            ? '— you still approve every stage'
            : '— you drive every message'}
      </span>
    </label>
  );
}
