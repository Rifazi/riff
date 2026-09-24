'use client';

import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { AlertTriangle, Loader2, RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/dev-sessions/api';

interface AgentServerStatus {
  state: 'starting' | 'running' | 'external' | 'failed' | 'stopped';
  url: string;
  message: string | null;
  serverDir: string | null;
  logPath: string | null;
}

export function useAgentServerHealth() {
  return useQuery({
    queryKey: ['agent-server-health'],
    queryFn: async () => {
      try {
        await api.getHealth();
        return true;
      } catch {
        return false;
      }
    },
    refetchInterval: (query) => (query.state.data ? 30_000 : 3_000),
  });
}

/** Shown on Dev Sessions pages only while the local agent server can't be reached. */
export function AgentServerBanner() {
  const queryClient = useQueryClient();
  const { data: healthy } = useAgentServerHealth();
  const [status, setStatus] = useState<AgentServerStatus | null>(null);
  const [restarting, setRestarting] = useState(false);

  useEffect(() => {
    invoke<AgentServerStatus>('get_agent_server_status').then(setStatus).catch(() => {});
    const unlisten = listen<AgentServerStatus>('agent-server-status', (event) => {
      setStatus(event.payload);
      queryClient.invalidateQueries({ queryKey: ['agent-server-health'] });
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [queryClient]);

  useEffect(() => {
    if (healthy) queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'agent-server-health' });
  }, [healthy, queryClient]);

  if (healthy !== false) return null;

  const starting = restarting || status?.state === 'starting';

  const restart = async () => {
    setRestarting(true);
    try {
      setStatus(await invoke<AgentServerStatus>('restart_agent_server'));
    } catch (err) {
      setStatus((prev) => ({
        state: 'failed',
        url: prev?.url ?? '',
        serverDir: prev?.serverDir ?? null,
        logPath: prev?.logPath ?? null,
        message: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      setRestarting(false);
      queryClient.invalidateQueries({ queryKey: ['agent-server-health'] });
    }
  };

  return (
    <div className="flex-shrink-0 mx-8 mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 flex items-start gap-3">
      {starting ? (
        <Loader2 className="w-4 h-4 mt-0.5 animate-spin flex-shrink-0" />
      ) : (
        <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
      )}
      <div className="flex-1 min-w-0">
        <div className="font-medium">
          {starting ? 'Starting the agent server…' : "The agent server isn't running"}
        </div>
        <div className="text-amber-800 mt-0.5 break-words">
          {starting
            ? 'Requirements, planning, coding and QA agents will be available in a moment.'
            : status?.message ?? 'Requirements, planning, coding and QA agents are unavailable until it starts.'}
        </div>
        {!starting && status?.logPath && (
          <div className="text-xs text-amber-700 mt-1 font-mono break-all">Log: {status.logPath}</div>
        )}
      </div>
      {!starting && (
        <Button size="sm" variant="outline" onClick={restart} className="bg-white">
          <RotateCw />
          Restart
        </Button>
      )}
    </div>
  );
}
