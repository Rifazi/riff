'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, ExternalLink, Loader2, Wrench } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/dev-sessions/api';
import type { AttachmentInput, SessionRecord } from '@/lib/dev-sessions/types';
import { useAgentTurnStream } from '@/lib/dev-sessions/useAgentTurnStream';
import { AGENT_PERSONAS } from '@/lib/dev-sessions/agents';
import { sessionHref } from '@/lib/dev-sessions/stage';
import { ChatPane } from '../ChatPane';
import { ExternalAnchor } from '../ExternalAnchor';
import { ApprovalBar } from '../ApprovalBar';
import { CoordinatorControl } from '../CoordinatorControl';
import { DocumentCard } from '../DocumentCard';
import { ErrorText, Pill } from '../PageShell';
import { StageLayout } from './StageLayout';

const AGENT = AGENT_PERSONAS.qa;

function parseFrontmatterField(markdown: string, field: string): string | null {
  const match = new RegExp(`^${field}:\\s*(.+)$`, 'm').exec(markdown);
  return match ? match[1].trim() : null;
}

function ResultPill({ label, value }: { label: string; value: string | null }) {
  return (
    <Pill tone={value === 'pass' ? 'green' : value === 'fail' ? 'red' : 'neutral'}>
      {label}: {value ?? '—'}
    </Pill>
  );
}

export function QaStage({ session }: { session: SessionRecord }) {
  const sessionId = session.id;
  const queryClient = useQueryClient();
  const router = useRouter();
  const { data: report } = useQuery({
    queryKey: ['qa-report', sessionId, session.qaReportPath],
    queryFn: () => api.getQaReport(sessionId),
  });
  const { data: apps } = useQuery({ queryKey: ['apps'], queryFn: api.listApps, staleTime: Infinity });
  const repoUrl = apps?.find((a) => a.id === session.appId)?.repoUrl ?? null;

  const { overlay, streaming, runningTool, error, send, runCoordinator } = useAgentTurnStream();
  const kickedOff = useRef(false);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['session', sessionId] });
    queryClient.invalidateQueries({ queryKey: ['sessions'] });
    queryClient.invalidateQueries({ queryKey: ['qa-report', sessionId] });
  };

  const approveMutation = useMutation({ mutationFn: () => api.approveQa(sessionId), onSuccess: refresh });
  const rejectMutation = useMutation({ mutationFn: () => api.rejectQa(sessionId), onSuccess: refresh });

  // Distinct from Reject: reopens Coding for fixes instead of abandoning the
  // session. The QA report stays as the record of what was found.
  const sendBackMutation = useMutation({
    mutationFn: () => api.sendQaBack(sessionId),
    onSuccess: () => {
      refresh();
      router.push(sessionHref(sessionId, 'coding'));
    },
  });

  const handleSend = (message: string, attachments?: AttachmentInput[]) =>
    send(`/api/sessions/${sessionId}/qa/message`, message, refresh, (event) => {
      if (event.type === 'tool_result') queryClient.invalidateQueries({ queryKey: ['qa-report', sessionId] });
    }, attachments);

  useEffect(() => {
    if (session.stage !== 'qa-in-progress') return;
    if (session.transcripts.qa.length > 0) return;
    if (kickedOff.current) return;
    kickedOff.current = true;
    if (session.coordinatorEnabled) {
      void runCoordinator(sessionId, refresh);
    } else {
      void handleSend(
        'Please review this branch against the requirements document, run lint and the unit test suite, and write the QA report.'
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id, session.stage]);

  const entries = streaming ? [...session.transcripts.qa, ...overlay] : session.transcripts.qa;
  const reviewed = session.qaStatus === 'reviewed';
  const markdown = report?.markdown ?? null;
  const pushCommand = session.branch ? `git push -u origin ${session.branch}` : null;

  return (
    <StageLayout
      toolbar={<CoordinatorControl session={session} streaming={streaming} />}
      chat={
        <>
          <ChatPane
            entries={entries}
            onSend={handleSend}
            disabled={streaming || reviewed}
            streaming={streaming}
            runningTool={runningTool}
            agent={AGENT}
            emptyHint={`${AGENT.name} reviews the branch against the requirements and runs the checks.`}
            placeholder={reviewed ? 'QA reviewed — read only.' : `Ask ${AGENT.name} to re-check something…`}
          />
          <ErrorText>{error}</ErrorText>
        </>
      }
      document={
        <DocumentCard
          title="QA report"
          subtitle={markdown ? session.qaReportPath : null}
          markdown={markdown}
          emptyText="Not written yet — QA is running…"
          badge={reviewed ? <Pill tone="green">Reviewed</Pill> : null}
          notices={
            markdown && (
              <div className="flex flex-wrap gap-1.5">
                <ResultPill label="result" value={parseFrontmatterField(markdown, 'result')} />
                <ResultPill label="lint" value={parseFrontmatterField(markdown, 'lint')} />
                <ResultPill label="unit tests" value={parseFrontmatterField(markdown, 'unit-tests')} />
                <ResultPill label="integration tests" value={parseFrontmatterField(markdown, 'integration-tests')} />
              </div>
            )
          }
          footer={
            <>
              {!reviewed && (
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-3"
                  onClick={() => sendBackMutation.mutate()}
                  disabled={streaming || sendBackMutation.isPending}
                  title={
                    session.qaReportPath
                      ? `Reopen Coding so ${AGENT_PERSONAS.coding.name} can fix what ${AGENT.name} found.`
                      : `Reopen Coding without a QA report — e.g. if ${AGENT.name} was interrupted before reviewing anything.`
                  }
                >
                  {sendBackMutation.isPending ? <Loader2 className="animate-spin" /> : <Wrench />}
                  {sendBackMutation.isPending ? 'Sending back…' : session.qaReportPath ? 'Send back for fixes' : 'Reopen coding'}
                </Button>
              )}
              <ApprovalBar
                approveLabel={reviewed ? 'Reviewed' : 'Mark reviewed'}
                onApprove={() => approveMutation.mutate()}
                approveDisabled={reviewed || !session.qaReportPath || streaming}
                approveDisabledReason={!session.qaReportPath ? 'No QA report yet' : undefined}
                busy={approveMutation.isPending}
                onReject={() => rejectMutation.mutate()}
                rejectDisabled={reviewed || streaming}
                rejectBusy={rejectMutation.isPending}
              />
              {session.stage === 'done' && pushCommand && (
                <div className="mt-3 rounded-md border border-green-200 bg-green-50 p-3 text-sm text-green-900 space-y-2">
                  <div>
                    Done. Nothing was pushed or merged automatically — review <code>{session.branch}</code> and push it
                    yourself when ready:
                  </div>
                  <pre className="bg-white border border-green-200 rounded px-2 py-1 text-xs font-mono text-gray-800">{pushCommand}</pre>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      className="bg-white"
                      onClick={async () => {
                        await navigator.clipboard.writeText(pushCommand);
                        toast.success('Push command copied');
                      }}
                    >
                      <Copy />
                      Copy push command
                    </Button>
                    {repoUrl && (
                      <Button size="sm" variant="outline" className="bg-white" asChild>
                        <ExternalAnchor
                          href={`${repoUrl}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${encodeURIComponent(session.branch!)}`}
                        >
                          <ExternalLink />
                          Open merge request
                        </ExternalAnchor>
                      </Button>
                    )}
                  </div>
                </div>
              )}
            </>
          }
        />
      }
    />
  );
}
