'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Loader2, Repeat, TriangleAlert, Wrench, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/dev-sessions/api';
import type { AttachmentInput, QaBlockerKind, QaPassSummary, SessionRecord } from '@/lib/dev-sessions/types';
import { useAgentTurnStream } from '@/lib/dev-sessions/useAgentTurnStream';
import { AGENT_PERSONAS, QA_LEAD_PERSONA } from '@/lib/dev-sessions/agents';
import { teamStatusKey, useTeamBoard } from '@/lib/dev-sessions/useTeamBoard';
import { sessionHref } from '@/lib/dev-sessions/stage';
import { ChatPane } from '../ChatPane';
import { DeliveryPanel } from '../DeliveryPanel';
import { ApprovalBar } from '../ApprovalBar';
import { useCoordinatorAutoRun } from '@/lib/dev-sessions/useCoordinatorAutoRun';
import { CoordinatorControl } from '../CoordinatorControl';
import { DocumentCard } from '../DocumentCard';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ErrorText, Notice } from '../PageShell';
import { QaNotes } from '../QaNotes';
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

const VERDICT: Record<string, { tone: 'green' | 'amber' | 'red'; icon: typeof CheckCircle2; title: string; hint?: string }> = {
  pass: { tone: 'green', icon: CheckCircle2, title: 'QA passed' },
  'pass-with-notes': {
    tone: 'amber',
    icon: TriangleAlert,
    title: 'QA passed with notes',
    hint: 'Nothing blocks, but there are notes to act on — send it back so they get fixed, or mark it reviewed as is.',
  },
  fail: { tone: 'red', icon: XCircle, title: 'QA failed', hint: 'Send it back for fixes, or reject the session.' },
};

// The headline verdict and the check results in one block, so pass/fail is
// obvious before reading the report.
function QaVerdict({ markdown }: { markdown: string }) {
  const result = parseFrontmatterField(markdown, 'result');
  const verdict = result ? VERDICT[result] : undefined;
  const checks = (
    <div className="flex flex-wrap gap-1.5">
      {!verdict && <ResultPill label="result" value={result} />}
      <ResultPill label="lint" value={parseFrontmatterField(markdown, 'lint')} />
      <ResultPill label="unit tests" value={parseFrontmatterField(markdown, 'unit-tests')} />
      <ResultPill label="integration tests" value={parseFrontmatterField(markdown, 'integration-tests')} />
    </div>
  );
  if (!verdict) return checks;
  const Icon = verdict.icon;
  return (
    <Notice tone={verdict.tone}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <div className="flex items-center gap-2 font-semibold">
          <Icon className="h-4 w-4" /> {verdict.title}
        </div>
        {checks}
      </div>
      {verdict.hint && <div className="mt-1 text-xs">{verdict.hint}</div>}
    </Notice>
  );
}

const BLOCKER_KIND: Record<QaBlockerKind, string> = {
  repeated: 'came back',
  'was-note': 'was a note',
  'in-fix': 'in the fix',
  missed: 'new',
};

// Shown when QA keeps sending the branch back (harness-server sessions/qa-loop.ts):
// why, per blocker, and what to do instead of another full round.
function QaLoopNotice({ sessionId, version }: { sessionId: string; version: string }) {
  const { data } = useQuery({
    queryKey: ['qa-loop', sessionId, version],
    queryFn: () => api.getQaLoop(sessionId),
  });
  const loop = data?.loop;
  if (!loop?.looping) return null;
  return (
    <Notice tone="amber">
      <div className="flex items-center gap-2 font-semibold">
        <Repeat className="h-4 w-4" /> This branch keeps coming back from QA
      </div>
      <div className="mt-1 text-xs">{loop.reasons.join(' ')}</div>
      <ul className="mt-2 space-y-1 text-xs">
        {loop.blockers.map((b, i) => (
          <li key={i} className="flex items-start gap-2">
            <Badge variant="outline" className="shrink-0">
              {BLOCKER_KIND[b.kind]}
            </Badge>
            <span className="line-clamp-2">{b.text}</span>
          </li>
        ))}
      </ul>
      <div className="mt-2 text-xs">
        {loop.smallFix
          ? 'What’s left is small. Sending it back runs one solo fix and a QA pass on just that fix, or fix it by hand and mark it reviewed.'
          : 'Read the report before sending it back: the same areas keep failing, so the requirements or the plan may be what’s wrong.'}
      </div>
    </Notice>
  );
}

const RESULT_LABEL: Record<string, string> = { pass: 'passed', 'pass-with-notes': 'passed with notes', fail: 'failed' };

function passLabel(p: QaPassSummary): string {
  const when = new Date(p.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return `Pass ${p.pass} · ${p.result ? (RESULT_LABEL[p.result] ?? p.result) : 'no result'} · ${when}`;
}

// The report pane shows only this pass's report; earlier passes are one pick away.
function PassPicker({ passes, value, onChange }: { passes: QaPassSummary[]; value: number | null; onChange: (pass: number | null) => void }) {
  return (
    <Select value={value === null ? 'current' : String(value)} onValueChange={(v) => onChange(v === 'current' ? null : Number(v))}>
      <SelectTrigger className="h-8 w-auto gap-2 text-xs" aria-label="QA pass">
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        <SelectItem value="current">This pass</SelectItem>
        {passes.map((p) => (
          <SelectItem key={p.pass} value={String(p.pass)}>
            {passLabel(p)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
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

  // An earlier pass picked in the report pane; null = this pass.
  const [viewPass, setViewPass] = useState<number | null>(null);
  const { data: pastReport } = useQuery({
    queryKey: ['qa-report', sessionId, 'pass', viewPass],
    queryFn: () => api.getQaReport(sessionId, viewPass!),
    enabled: viewPass !== null,
  });
  // A new pass starting goes back to its own (empty) report.
  useEffect(() => setViewPass(null), [report?.pass]);

  const { overlay, streaming, runningTool, error, send, runCoordinator } = useAgentTurnStream();

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['session', sessionId] });
    queryClient.invalidateQueries({ queryKey: ['sessions'] });
    queryClient.invalidateQueries({ queryKey: ['qa-report', sessionId] });
    queryClient.invalidateQueries({ queryKey: ['qa-loop', sessionId] });
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
    restartMember,
    restarting,
    restartError,
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
      // The session only refetches when the turn ends, but a tool can change it
      // mid-turn (assign_qa_team adds the team board), so refresh on each result.
      if (event.type === 'tool_result') {
        queryClient.invalidateQueries({ queryKey: ['qa-report', sessionId] });
        queryClient.invalidateQueries({ queryKey: ['session', sessionId] });
        queryClient.invalidateQueries({ queryKey: teamStatusKey('qa', sessionId) });
      }
    }, attachments);

  useEffect(() => {
    // With Bridget on, she kicks QA off (useCoordinatorAutoRun below).
    if (session.coordinatorEnabled) return;
    if (session.stage !== 'qa-in-progress') return;
    const rerun = session.qaRerunPending;
    if (!rerun && session.transcripts.qa.length > 0) return;
    const approvalKey = session.codingApprovedAt ?? '';
    if (kickedOffForApproval.get(sessionId) === approvalKey) return;
    kickedOffForApproval.set(sessionId, approvalKey);
    void handleSend(rerun ? QA_RERUN_MESSAGE : QA_KICKOFF_MESSAGE);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id, session.stage, session.qaRerunPending, session.codingApprovedAt]);

  // Bridget kicks QA off, waits for its team, and ships a clean pass as an MR.
  useCoordinatorAutoRun({ session, group: 'qa', streaming, runCoordinator, refresh });

  // Every reviewer reported: hand the findings to the lead, once per round.
  // A round that needs attention waits for the human (resume, or ask the lead).
  useEffect(() => {
    // Bridget hands the findings over herself when she's driving.
    if (session.coordinatorEnabled) return;
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
  // A part kept on its branch for the next one can still be sent back.
  const delivered = Boolean(session.delivery && session.delivery.kind !== 'pushed' && session.delivery.kind !== 'kept');
  // The report on file is an earlier pass's until this pass writes its own
  // (harness-server qaReportIsCurrent), so it isn't shown as this pass's.
  const staleReport = Boolean(report?.markdown) && report?.current === false;
  const markdown = staleReport ? null : (report?.markdown ?? null);
  const qaResult = markdown ? parseFrontmatterField(markdown, 'result') : null;
  const earlierPasses = (report?.passes ?? [])
    .filter((p) => p.hasReport && !(report?.current && p.pass === report.pass))
    .reverse();
  const viewed = viewPass === null ? null : earlierPasses.find((p) => p.pass === viewPass) ?? null;

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
          <QaNotes notes={session.qaHandoffNotes ?? []} title={`Notes from ${AGENT_PERSONAS.coding.name}`} />
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
              onRestart={restartMember}
              canRestart={!reviewed}
              restartingId={restarting}
              leadChat={leadChat}
              leadActive={streaming}
            />
          ) : (
            leadChat
          )}
          <ErrorText>{team.error ?? restartError ?? error}</ErrorText>
        </div>
      }
      document={
        <DocumentCard
          title="QA report"
          subtitle={viewed ? null : markdown ? session.qaReportPath : null}
          markdown={viewed ? (pastReport?.markdown ?? null) : markdown}
          emptyText={
            viewed
              ? 'Loading…'
              : teamActive
                ? 'Not written yet — the reviewers are still checking…'
                : staleReport || busy
                  ? `Not written yet — ${AGENT.name} is reviewing this pass…`
                  : 'Not written yet — QA is running…'
          }
          badge={
            <>
              {earlierPasses.length > 0 && <PassPicker passes={earlierPasses} value={viewed ? viewPass : null} onChange={setViewPass} />}
              {reviewed && !viewed && <Badge variant="success">Reviewed</Badge>}
            </>
          }
          scrollFooter
          notices={
            viewed ? (
              <div className="space-y-2">
                <Notice tone="neutral">
                  An earlier pass, for reference.{' '}
                  <button type="button" className="underline" onClick={() => setViewPass(null)}>
                    Back to this pass
                  </button>
                </Notice>
                {pastReport?.markdown && <QaVerdict markdown={pastReport.markdown} />}
              </div>
            ) : (
              markdown && (
                <div className="space-y-2">
                  <QaVerdict markdown={markdown} />
                  <QaLoopNotice sessionId={sessionId} version={session.updatedAt} />
                </div>
              )
            )
          }
          footer={
            !viewed && (
              <>
                <ApprovalBar
                  approveLabel={reviewed ? 'Reviewed' : 'Mark reviewed'}
                  onApprove={() => approveMutation.mutate()}
                  approveDisabled={reviewed || !markdown || busy}
                  approveDisabledReason={!markdown ? 'This pass hasn’t written its report yet' : undefined}
                  busy={approveMutation.isPending}
                  onReject={() => rejectMutation.mutate()}
                  rejectDisabled={reviewed || busy}
                  rejectBusy={rejectMutation.isPending}
                  secondaryActions={
                    // Nothing to fix on a clean pass.
                    !delivered &&
                    qaResult !== 'pass' && (
                      <Button
                        variant="outline"
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
                        {sendBackMutation.isPending
                          ? 'Sending back…'
                          : session.qaReportPath
                            ? 'Send back for fixes'
                            : 'Reopen coding'}
                      </Button>
                    )
                  }
                />
                {reviewed && session.branch && <DeliveryPanel session={session} qaResult={qaResult} />}
              </>
            )
          }
        />
      }
    />
  );
}
