'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Loader2, TriangleAlert, Wrench, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/dev-sessions/api';
import type { AttachmentInput, SessionRecord } from '@/lib/dev-sessions/types';
import { useAgentTurnStream } from '@/lib/dev-sessions/useAgentTurnStream';
import { AGENT_PERSONAS } from '@/lib/dev-sessions/agents';
import { sessionHref } from '@/lib/dev-sessions/stage';
import { ChatPane } from '../ChatPane';
import { DeliveryPanel } from '../DeliveryPanel';
import { ApprovalBar } from '../ApprovalBar';
import { CoordinatorControl } from '../CoordinatorControl';
import { DocumentCard } from '../DocumentCard';
import { ErrorText, Notice, Pill } from '../PageShell';
import { StageLayout } from './StageLayout';

const AGENT = AGENT_PERSONAS.qa;
const QA_KICKOFF_MESSAGE =
  'Please review this branch against the requirements document, run lint and the unit test suite, and write the QA report.';
// Sent instead when coding was re-approved after a send-back. Keep in sync
// with QA_RERUN_MESSAGE in harness-server's routes/coordinator.ts.
const QA_RERUN_MESSAGE =
  'The coding agent has pushed fixes for your last report. Please re-review the branch against the requirements document, re-run lint and the unit test suite, and write an updated QA report.';

function parseFrontmatterField(markdown: string, field: string): string | null {
  const match = new RegExp(`^${field}:\\s*(.+)$`, 'm').exec(markdown);
  return match ? match[1].trim() : null;
}

function ResultPill({ label, value }: { label: string; value: string | null }) {
  return (
    <Pill tone={value === 'pass' ? 'green' : value === 'fail' ? 'red' : value === 'pass-with-notes' ? 'amber' : 'neutral'}>
      {label}: {value ?? '—'}
    </Pill>
  );
}

// The headline verdict, so pass/fail is obvious before reading the report.
function QaVerdict({ result }: { result: string | null }) {
  if (result === 'pass')
    return (
      <Notice tone="green">
        <div className="flex items-center gap-2 font-semibold">
          <CheckCircle2 className="h-4 w-4" /> QA passed
        </div>
      </Notice>
    );
  if (result === 'pass-with-notes')
    return (
      <Notice tone="amber">
        <div className="flex items-center gap-2 font-semibold">
          <TriangleAlert className="h-4 w-4" /> QA passed with notes
        </div>
        <div className="mt-0.5 text-xs">Nothing blocks, but there are notes to act on — send it back so they get fixed, or mark it reviewed as is.</div>
      </Notice>
    );
  if (result === 'fail')
    return (
      <Notice tone="red">
        <div className="flex items-center gap-2 font-semibold">
          <XCircle className="h-4 w-4" /> QA failed
        </div>
        <div className="mt-0.5 text-xs">Send it back for fixes, or reject the session.</div>
      </Notice>
    );
  return null;
}

export function QaStage({ session }: { session: SessionRecord }) {
  const sessionId = session.id;
  const queryClient = useQueryClient();
  const router = useRouter();
  const { data: report } = useQuery({
    queryKey: ['qa-report', sessionId, session.qaReportPath],
    queryFn: () => api.getQaReport(sessionId),
  });

  const { overlay, streaming, runningTool, error, send, runCoordinator } = useAgentTurnStream();
  // Which coding approval QA was last kicked off for — a send-back and
  // re-approval gives a new codingApprovedAt, so a second pass can start
  // even if this component never unmounted.
  const kickedOff = useRef<string | null>(null);

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
    const rerun = session.qaRerunPending;
    if (!rerun && session.transcripts.qa.length > 0) return;
    const approvalKey = session.codingApprovedAt ?? '';
    if (kickedOff.current === approvalKey) return;
    kickedOff.current = approvalKey;
    if (session.coordinatorEnabled) {
      void runCoordinator(sessionId, refresh);
    } else {
      void handleSend(rerun ? QA_RERUN_MESSAGE : QA_KICKOFF_MESSAGE);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id, session.stage, session.qaRerunPending, session.codingApprovedAt]);

  const entries = streaming ? [...session.transcripts.qa, ...overlay] : session.transcripts.qa;
  const reviewed = session.qaStatus === 'reviewed';
  // Once merged or an MR is open, fixes on the branch no longer reach anything.
  const delivered = Boolean(session.delivery && session.delivery.kind !== 'pushed');
  const markdown = report?.markdown ?? null;
  const qaResult = markdown ? parseFrontmatterField(markdown, 'result') : null;

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
              <>
                <QaVerdict result={qaResult} />
                <div className="flex flex-wrap gap-1.5">
                  <ResultPill label="result" value={qaResult} />
                  <ResultPill label="lint" value={parseFrontmatterField(markdown, 'lint')} />
                  <ResultPill label="unit tests" value={parseFrontmatterField(markdown, 'unit-tests')} />
                  <ResultPill label="integration tests" value={parseFrontmatterField(markdown, 'integration-tests')} />
                </div>
              </>
            )
          }
          footer={
            <>
              {/* Nothing to fix on a clean pass. */}
              {!delivered && qaResult !== 'pass' && (
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-3"
                  onClick={() => sendBackMutation.mutate()}
                  disabled={streaming || sendBackMutation.isPending}
                  title={
                    reviewed
                      ? `Undo "Mark reviewed" and reopen Coding so ${AGENT_PERSONAS.coding.name} can fix what ${AGENT.name} found.`
                      : session.qaReportPath
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
              {reviewed && session.branch && <DeliveryPanel session={session} qaResult={qaResult} />}
            </>
          }
        />
      }
    />
  );
}
