'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, ExternalLink, FolderGit2, GitFork, Loader2, NotebookPen, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/dev-sessions/api';
import type { SessionRecord } from '@/lib/dev-sessions/types';
import { sessionHref, STAGE_LABEL, stageGroupFor } from '@/lib/dev-sessions/stage';
import { AGENT_PERSONAS } from '@/lib/dev-sessions/agents';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState, ErrorText, LoadingState, Notice, PageShell } from '@/components/DevSessions/PageShell';
import { ConfirmDialog } from '@/components/DevSessions/ConfirmDialog';
import { AppPicker } from '@/components/DevSessions/AppPicker';

function stageTone(session: SessionRecord) {
  if (session.stage === 'done') return 'success' as const;
  if (session.stage === 'abandoned') return 'destructive' as const;
  if (session.stage === 'split') return 'secondary' as const;
  if (session.stage.endsWith('approved') || session.stage === 'coding-review' || session.stage === 'qa-reviewed')
    return 'warning' as const;
  return 'info' as const;
}

export default function DevSessionsPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data: sessions, isLoading } = useQuery({ queryKey: ['sessions'], queryFn: () => api.listSessions() });
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.getSettings });
  const { data: apps } = useQuery({ queryKey: ['apps'], queryFn: api.listApps });
  const noProviderConfigured = settings && !Object.values(settings.credentials).some((c) => c.hasKey);

  const [title, setTitle] = useState('');
  const [sessionKey, setSessionKey] = useState('');
  const [appId, setAppId] = useState('');
  const [pendingDelete, setPendingDelete] = useState<SessionRecord | null>(null);

  const createMutation = useMutation({
    mutationFn: () => api.createSession({ title, sessionKey: sessionKey || undefined, appId }),
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
            <CardHeader>
              <CardTitle>Start a new session</CardTitle>
            </CardHeader>
            <CardContent>
              <form
                className="flex flex-wrap gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (title.trim() && appId) createMutation.mutate();
                }}
              >
                <AppPicker value={appId} onChange={setAppId} triggerClassName="w-44" />
                <Input
                  className="flex-1 min-w-[220px]"
                  placeholder="Feature title, e.g. Acme Distributors inventory report"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
                <Input
                  className="w-52"
                  placeholder="Ticket ID (optional)"
                  value={sessionKey}
                  onChange={(e) => setSessionKey(e.target.value)}
                />
                <Button variant="default" type="submit" disabled={!title.trim() || !appId || createMutation.isPending}>
                  {createMutation.isPending ? <Loader2 className="animate-spin" /> : <Plus />}
                  New session
                </Button>
              </form>
              <ErrorText>{createMutation.isError ? (createMutation.error as Error).message : null}</ErrorText>
              <p className="text-xs text-muted-foreground mt-3 flex items-center gap-1.5">
                <NotebookPen className="w-3.5 h-3.5" />
                Or open a meeting and click <span className="font-medium">Requirements</span> to start from its transcript.
              </p>
            </CardContent>
          </Card>
        )}

        <div>
          <h2 className="text-sm font-semibold text-foreground mb-3">Sessions</h2>
          {isLoading && <LoadingState />}
          {!isLoading && sessions?.length === 0 && <EmptyState>No sessions yet — start one above or from a meeting.</EmptyState>}
          <div className="space-y-2">
            {sessions?.map((session) => {
              const busyReopen = reopenMutation.isPending && reopenMutation.variables === session.id;
              const busyDelete = deleteMutation.isPending && deleteMutation.variables === session.id;
              return (
                <Link
                  key={session.id}
                  href={sessionHref(session.id, stageGroupFor(session))}
                  className="group flex items-center gap-4 bg-card rounded-lg border border-border px-4 py-3 hover:border-primary/50 hover:shadow-sm transition-all"
                >
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-foreground truncate">{session.title}</div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span className="font-mono">{session.sessionKey}</span>
                      <Badge variant="secondary">{session.appName}</Badge>
                      {session.splitFrom && (
                        <Badge variant="secondary" className="gap-1" title={`Split from "${session.splitFrom.title}"`}>
                          <GitFork className="w-3 h-3" />
                          {session.splitFrom.sessionKey}
                        </Badge>
                      )}
                      {session.sourceMeeting && (
                        <Badge
                          variant="info"
                          className="gap-1"
                          title={session.sourceMeeting.kind === 'journal' ? 'Started from a journal' : 'Started from a meeting transcript'}
                        >
                          <NotebookPen className="w-3 h-3" />
                          {session.sourceMeeting.meetingTitle || 'Meeting'}
                        </Badge>
                      )}
                      <span>Updated {new Date(session.updatedAt).toLocaleString()}</span>
                    </div>
                  </div>
                  <Badge variant={stageTone(session)}>{STAGE_LABEL[session.stage] ?? session.stage}</Badge>
                  <div className="flex items-center gap-1">
                    {session.stage === 'abandoned' && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          reopenMutation.mutate(session.id);
                        }}
                        disabled={busyReopen}
                        title="Resume this session wherever it was rejected from."
                      >
                        {busyReopen ? <Loader2 className="animate-spin" /> : <RotateCcw />}
                        Reopen
                      </Button>
                    )}
                    <Button
                      size="icon"
                      variant="ghost"
                      className="text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setPendingDelete(session);
                      }}
                      disabled={busyDelete}
                      aria-label="Delete session"
                    >
                      {busyDelete ? <Loader2 className="animate-spin" /> : <Trash2 />}
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="text-muted-foreground hover:text-foreground"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        invoke('open_session_window', { sessionId: session.id, title: session.title });
                      }}
                      aria-label="Open in new window"
                      title="Open in new window"
                    >
                      <ExternalLink className="w-4 h-4" />
                    </Button>
                    <ChevronRight className="w-4 h-4 text-muted-foreground/60 group-hover:text-muted-foreground" />
                  </div>
                </Link>
              );
            })}
          </div>
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
