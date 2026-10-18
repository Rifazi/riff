'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderGit2, Loader2, NotebookPen, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/dev-sessions/api';
import type { SessionRecord } from '@/lib/dev-sessions/types';
import { sessionHref, stageGroupFor } from '@/lib/dev-sessions/stage';
import { AGENT_PERSONAS } from '@/lib/dev-sessions/agents';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorText, LoadingState, Notice, PageShell } from '@/components/DevSessions/PageShell';
import { ConfirmDialog } from '@/components/DevSessions/ConfirmDialog';
import { AppPicker } from '@/components/DevSessions/AppPicker';
import { SessionList } from '@/components/DevSessions/SessionList';

export default function DevSessionsPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data: sessions, isLoading } = useQuery({ queryKey: ['sessions'], queryFn: () => api.listSessions() });
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.getSettings });
  const { data: apps } = useQuery({ queryKey: ['apps'], queryFn: api.listApps });
  const noProviderConfigured = settings && !Object.values(settings.credentials).some((c) => c.hasKey);

  const [formOpen, setFormOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [ticket, setTicket] = useState('');
  const [appId, setAppId] = useState('');
  const [existingBranch, setExistingBranch] = useState('');
  const [pendingDelete, setPendingDelete] = useState<SessionRecord | null>(null);

  const createMutation = useMutation({
    mutationFn: () => api.createSession({ title, ticket: ticket.trim() || undefined, appId, existingBranch: existingBranch || undefined }),
    onSuccess: (session) => {
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
      router.push(sessionHref(session.id, stageGroupFor(session)));
    },
  });

  // Permanent, unlike Reject — removes the session and its docs from the
  // agent server. A branch it created in the target repo is left untouched.
  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteSession(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['sessions'] }),
  });

  const reopenMutation = useMutation({
    mutationFn: (id: string) => api.reopenSession(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['sessions'] }),
  });

  return (
    <PageShell
      title="Dev Sessions"
      subtitle="Turn meetings and ideas into requirements, a plan, code and a QA report — with your approval at every step."
      actions={
        <Button variant="outline" asChild>
          <Link href="/dev-sessions/apps">
            <FolderGit2 />
            Apps
          </Link>
        </Button>
      }
    >
      <div className="space-y-6">
        {noProviderConfigured && (
          <Notice tone="amber">
            No AI provider is set up for the agents yet — {AGENT_PERSONAS.requirements.name}, {AGENT_PERSONAS.plan.name},{' '}
            {AGENT_PERSONAS.coding.name} and {AGENT_PERSONAS.qa.name} can't run until you do.{' '}
            <Link href="/settings?tab=devAgents" className="font-medium underline">
              Open Settings → Dev Agents
            </Link>
          </Notice>
        )}
        {apps && (
          <Card>
            <CardHeader className="max-md:flex-row max-md:items-center max-md:justify-between max-md:space-y-0">
              <CardTitle>Start a new session</CardTitle>
              {/* On a phone the form stays folded away so the session list is what you see first. */}
              <Button type="button" size="sm" variant="outline" className="md:hidden" onClick={() => setFormOpen((open) => !open)}>
                {formOpen ? 'Hide' : 'New'}
              </Button>
            </CardHeader>
            <CardContent className={formOpen ? undefined : 'max-md:hidden'}>
              <form
                className="flex flex-wrap gap-2 max-md:flex-col"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (title.trim() && appId) createMutation.mutate();
                }}
              >
                <AppPicker value={appId} onChange={setAppId} triggerClassName="w-44 max-md:w-full" />
                <Input
                  className="flex-1 min-w-[220px] max-md:min-w-0 max-md:w-full"
                  placeholder="Feature title, e.g. Acme Distributors inventory report"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
                <Input
                  className="w-52 max-md:w-full"
                  placeholder="Ticket ID (optional)"
                  value={ticket}
                  onChange={(e) => setTicket(e.target.value)}
                />
                <Input
                  className="w-52 max-md:w-full"
                  placeholder="Existing branch (optional)"
                  value={existingBranch}
                  onChange={(e) => setExistingBranch(e.target.value)}
                />
                <Button variant="default" type="submit" disabled={!title.trim() || !appId || createMutation.isPending}>
                  {createMutation.isPending ? <Loader2 className="animate-spin" /> : <Plus />}
                  New session
                </Button>
              </form>
              <ErrorText>{createMutation.isError ? (createMutation.error as Error).message : null}</ErrorText>
              <p className="text-xs text-muted-foreground mt-3 flex items-start gap-1.5">
                <NotebookPen className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span>
                  Or open a meeting and click <span className="font-medium">Requirements</span> to start from its transcript.
                </span>
              </p>
            </CardContent>
          </Card>
        )}

        <div>
          <h2 className="text-sm font-semibold text-foreground mb-3">Sessions</h2>
          {isLoading && <LoadingState />}
          {sessions && (
            <SessionList
              sessions={sessions}
              onReopen={(id) => reopenMutation.mutate(id)}
              onDelete={setPendingDelete}
              reopeningId={reopenMutation.isPending ? reopenMutation.variables : undefined}
              deletingId={deleteMutation.isPending ? deleteMutation.variables : undefined}
            />
          )}
        </div>
      </div>

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        title="Delete this session?"
        description={
          pendingDelete
            ? `"${pendingDelete.title}" (${pendingDelete.sessionKey}) and its requirements, plan and QA documents will be removed. Any branch it created in ${pendingDelete.appName} is left untouched. This can't be undone.`
            : ''
        }
        confirmLabel="Delete"
        destructive
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          if (pendingDelete) deleteMutation.mutate(pendingDelete.id);
          setPendingDelete(null);
        }}
      />
    </PageShell>
  );
}
