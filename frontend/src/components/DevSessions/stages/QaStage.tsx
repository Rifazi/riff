'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Loader2, TriangleAlert, Wrench, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/dev-sessions/api';
import type { AttachmentInput, SessionRecord } from '@/lib/dev-sessions/types';
import { useAgentTurnStream } from '@/lib/dev-sessions/useAgentTurnStream';
import { AGENT_PERSONAS, QA_LEAD_PERSONA } from '@/lib/dev-sessions/agents';
import { teamStatusKey, useTeamBoard } from '@/lib/dev-sessions/useTeamBoard';
import { sessionHref } from '@/lib/dev-sessions/stage';
import { ChatPane } from '../ChatPane';
import { DeliveryPanel } from '../DeliveryPanel';
import { ApprovalBar } from '../ApprovalBar';
import { CoordinatorControl } from '../CoordinatorControl';
import { DocumentCard } from '../DocumentCard';
import { Badge } from '@/components/ui/badge';
import { ErrorText, Notice } from '../PageShell';
import { StageLayout } from './StageLayout';
import { EarlierQaRounds, QaTeamPanel } from '../QaTeam';

const AGENT = AGENT_PERSONAS.qa;

// Module-level: persists across tab-switch remounts. Maps sessionId → the
// codingApprovedAt value for which QA was last kicked off, so re-approval
// after a send-back still triggers a new pass even without unmounting.
const kickedOffForApproval = new Map<string, string>();
const QA_KICKOFF_MESSAGE =
  'Please review this branch against the requirements document, run lint and the unit test suite, and write the QA report.';
// Sent instead when coding was re-approved after a send-back. Keep in sync
// with QA_RERUN_MESSAGE in harness-server's routes/coordinator.ts.
const QA_RERUN_MESSAGE =
  'The coding agent has pushed fixes for your last report. Please re-review the branch against the requirements document, re-run lint and the unit test suite, and write an updated QA report.';

// Sent to the QA lead once its team has finished; the server puts every
// reviewer's findings and the check results ahead of it (qa-agent.ts).
const QA_TEAM_WRAPUP_MESSAGE = 'Your reviewers have finished. Write the QA report from their findings.';
// Module-level, like kickedOffForApproval: `${sessionId}:${round}` of team
// rounds whose wrap-up was already sent.
const wrappedUpRounds = new Set<string>();

function parseFrontmatterField(markdown: string, field: string): string | null {
  const match = new RegExp(`^${field}:\\s*(.+)$`, 'm').exec(markdown);
  return match ? match[1].trim() : null;
}

function ResultPill({ label, value }: { label: string; value: string | null }) {
  return (
    <Badge
      variant={value === 'pass' ? 'success' : value === 'fail' ? 'destructive' : value === 'pass-with-notes' ? 'warning' : 'secondary'}
    >
      {label}: {value ?? '—'}
    </Badge>
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

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['session', sessionId] });
    queryClient.invalidateQueries({ queryKey: ['sessions'] });
    queryClient.invalidateQueries({ queryKey: ['qa-report', sessionId] });
    queryClient.invalidateQueries({ queryKey: teamStatusKey('qa', sessionId) });
  };

  // Team mode: the QA lead (Tess) split the review across reviewers who
  // check the branch in parallel (see harness-server agents/team/qa-team.ts).
  const qaTeam = session.qaTeam;
  const teamMode = Boolean(qaTeam);
  const {
    run: team,
    active: teamActive,
    status: teamStatus,
    finished: teamFinished,
    start: startTeam,
    entriesFor,
  } = useTeamBoard({ sessionId, kind: 'qa', team: qaTeam, leadBusy: streaming, refresh });

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
    if (kickedOffForApproval.get(sessionId) === approvalKey) return;
    kickedOffForApproval.set(sessionId, approvalKey);
    if (session.coordinatorEnabled) {
      void runCoordinator(sessionId, refresh);
    } else {
      void handleSend(rerun ? QA_RERUN_MESSAGE : QA_KICKOFF_MESSAGE);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id, session.stage, session.qaRerunPending, session.codingApprovedAt]);

  // Every reviewer reported: hand the findings to the lead, once per round.
  // A round that needs attention waits for the human (resume, or ask the lead).
  useEffect(() => {
    if (!qaTeam || qaTeam.status !== 'done' || qaTeam.relayed || streaming || teamActive) return;
    const key = `${sessionId}:${qaTeam.round}`;
    if (wrappedUpRounds.has(key)) return;
    wrappedUpRounds.add(key);
    void handleSend(QA_TEAM_WRAPUP_MESSAGE);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qaTeam?.status, qaTeam?.relayed, qaTeam?.round, streaming, teamActive]);

  const entries = streaming ? [...session.transcripts.qa, ...overlay] : session.transcripts.qa;
  const reviewed = session.qaStatus === 'reviewed';
  // Once merged or an MR is open, fixes on the branch no longer reach anything.
  const delivered = Boolean(session.delivery && session.delivery.kind !== 'pushed');
  const markdown = report?.markdown ?? null;
  const qaResult = markdown ? parseFrontmatterField(markdown, 'result') : null;

  const busy = streaming || teamActive;
  const canStartTeam =
    teamMode &&
    !teamActive &&
    !reviewed &&
    (teamStatus === 'not_started' || teamStatus === 'interrupted' || teamStatus === 'needs_attention');
  const earlierRounds = <EarlierQaRounds rounds={session.qaTeamHistory ?? []} />;

  const leadChat = (
    <ChatPane
      entries={entries}
      onSend={handleSend}
      disabled={busy || reviewed}
      streaming={streaming}
      runningTool={runningTool}
      agent={teamMode ? QA_LEAD_PERSONA : AGENT}
      emptyHint={`${AGENT.name} reviews the branch against the requirements, splitting it across reviewers when it's big enough, and runs the checks.`}
      placeholder={
        reviewed
          ? 'QA reviewed — read only.'
          : teamActive
            ? `${AGENT.name} takes messages once the reviewers have finished…`
            : `Ask ${AGENT.name} to re-check something…`
      }
    />
  );

  return (
    <StageLayout
      toolbar={<CoordinatorControl session={session} streaming={streaming} />}
      chat={
        <div className="flex flex-col flex-1 min-h-0 gap-3">
          {earlierRounds}
          {qaTeam ? (
            <QaTeamPanel
              team={qaTeam}
              teamStatus={teamStatus}
              teamFinished={teamFinished}
              entriesFor={entriesFor}
              runningTools={team.runningTools}
              canStart={canStartTeam}
              starting={team.running}
              onStart={startTeam}
              leadChat={leadChat}
              leadActive={streaming}
            />
          ) : (
            leadChat
          )}
          <ErrorText>{team.error ?? error}</ErrorText>
        </div>
      }
      document={
        <DocumentCard
          title="QA report"
          subtitle={markdown ? session.qaReportPath : null}
          markdown={markdown}
          emptyText={teamActive ? 'Not written yet — the reviewers are still checking…' : 'Not written yet — QA is running…'}
          badge={reviewed ? <Badge variant="success">Reviewed</Badge> : null}
          scrollFooter
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
                  disabled={busy || sendBackMutation.isPending}
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
                approveDisabled={reviewed || !session.qaReportPath || busy}
                approveDisabledReason={!session.qaReportPath ? 'No QA report yet' : undefined}
                busy={approveMutation.isPending}
                onReject={() => rejectMutation.mutate()}
                rejectDisabled={reviewed || busy}
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
