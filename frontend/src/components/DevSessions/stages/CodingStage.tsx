'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { GitBranch, GitCommit, Loader2, MessageSquare, Play, Undo2, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/dev-sessions/api';
import type { AttachmentInput, CodingTeamMember, SessionRecord } from '@/lib/dev-sessions/types';
import { useAgentTurnStream } from '@/lib/dev-sessions/useAgentTurnStream';
import { AGENT_PERSONAS, COORDINATOR_PERSONA, TEAM_LEAD_PERSONA } from '@/lib/dev-sessions/agents';
import { useTeamRun } from '@/lib/dev-sessions/useTeamRun';
import { sessionHref } from '@/lib/dev-sessions/stage';
import { ChatPane } from '../ChatPane';
import { ApprovalBar } from '../ApprovalBar';
import { CoordinatorControl } from '../CoordinatorControl';
import { CodingPlanChecklist } from '../CodingPlanChecklist';
import { CodingTeamBoard } from '../CodingTeam';
import { DiffViewer } from '../DiffViewer';
import { ErrorText, Notice, Pill } from '../PageShell';
import { StageLayout } from './StageLayout';

const AGENT = AGENT_PERSONAS.coding;

// Generous cap on consecutive auto-continues — a step may legitimately need
// a retry (e.g. after a lint failure). Guards against a plan whose steps
// never advance rather than limiting normal use.
const MAX_AUTO_RUN_ATTEMPTS = 20;
const CODING_KICKOFF_MESSAGE = 'Please implement the approved plan.';

export function CodingStage({ session }: { session: SessionRecord }) {
  const sessionId = session.id;
  const queryClient = useQueryClient();
  const router = useRouter();
  const { data: diffData } = useQuery({
    queryKey: ['coding-diff', sessionId, session.branch],
    queryFn: () => api.getCodingDiff(sessionId),
    enabled: Boolean(session.branch),
  });

  const { overlay, streaming, runningTool, error, send, runCoordinator } = useAgentTurnStream();
  const [autoRun, setAutoRun] = useState(false);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['session', sessionId] });
    queryClient.invalidateQueries({ queryKey: ['sessions'] });
    queryClient.invalidateQueries({ queryKey: ['coding-diff', sessionId] });
    queryClient.invalidateQueries({ queryKey: ['team-status', sessionId] });
  };

  // Team mode: the approved plan split the work into 2+ workstreams, so a
  // team of agents codes it in parallel (see harness-server agents/team/).
  // Wait for the plan to load before deciding, so the single-agent kickoff
  // below can't fire for a team plan.
  const { data: planDoc } = useQuery({
    queryKey: ['plan-doc', sessionId, session.planPath],
    queryFn: () => api.getPlanDoc(sessionId),
  });
  const teamMode = Boolean(session.codingTeam) || (planDoc?.workstreams.length ?? 0) >= 2;
  const team = useTeamRun();
  const codingTeam = session.codingTeam;
  // A run keeps going server-side if this page is closed; the persisted
  // status alone can't tell that apart from a run cut off by a restart.
  const { data: teamServer } = useQuery({
    queryKey: ['team-status', sessionId],
    queryFn: () => api.getTeamStatus(sessionId),
    enabled: teamMode,
  });
  const teamActive = team.running || (codingTeam?.status === 'running' && teamServer?.running !== false);
  const teamStatus = !codingTeam
    ? ('not_started' as const)
    : codingTeam.status === 'running' && !teamActive
      ? ('interrupted' as const)
      : codingTeam.status;
  const teamFinished = Boolean(codingTeam) && !teamActive && (teamStatus === 'done' || teamStatus === 'needs_attention');
  const [view, setView] = useState<'team' | 'lead'>('team');

  // Watching a run started elsewhere (another window, or before a reload):
  // poll instead of streaming.
  useEffect(() => {
    if (team.running || codingTeam?.status !== 'running') return;
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [team.running, codingTeam?.status]);

  const startTeam = () => void team.start(sessionId, refresh);

  const kickedOffTeam = useRef(false);
  useEffect(() => {
    if (!teamMode || codingTeam || session.branch || team.running) return;
    if (kickedOffTeam.current) return;
    kickedOffTeam.current = true;
    startTeam();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamMode, codingTeam, session.branch, team.running]);

  const entriesFor = (member: CodingTeamMember) =>
    team.running && team.startedAt
      ? [...member.transcript.filter((e) => e.timestamp < team.startedAt!), ...(team.overlays[member.id] ?? [])]
      : member.transcript;

  const approveMutation = useMutation({
    mutationFn: () => api.approveCoding(sessionId),
    onSuccess: () => {
      refresh();
      router.push(sessionHref(sessionId, 'qa'));
    },
  });

  const rejectMutation = useMutation({ mutationFn: () => api.rejectCoding(sessionId), onSuccess: refresh });

  const [showSendBackForm, setShowSendBackForm] = useState(false);
  const [sendBackNote, setSendBackNote] = useState('');
  const sendBackMutation = useMutation({
    mutationFn: (note: string) => api.sendBackToRequirements(sessionId, note),
    onSuccess: () => {
      refresh();
      setShowSendBackForm(false);
      setSendBackNote('');
      router.push(sessionHref(sessionId, 'requirements'));
    },
  });

  const kickedOffCoordinator = useRef(false);
  useEffect(() => {
    if (teamMode) return;
    if (!session.coordinatorEnabled) return;
    if (session.transcripts.coding.length > 0) return;
    if (streaming) return;
    if (kickedOffCoordinator.current) return;
    kickedOffCoordinator.current = true;
    void runCoordinator(sessionId, refresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id, session.coordinatorEnabled, session.transcripts.coding.length, streaming]);

  const handleSend = (message: string, attachments?: AttachmentInput[]) =>
    send(`/api/sessions/${sessionId}/coding/message`, message, refresh, (event) => {
      // Refresh on every tool result so the branch, diff and commits appear
      // as the agent works instead of only when the whole turn finishes.
      if (event.type === 'tool_result') {
        queryClient.invalidateQueries({ queryKey: ['session', sessionId] });
        queryClient.invalidateQueries({ queryKey: ['coding-diff', sessionId] });
      }
    }, attachments);

  // Kick off automatically when reached with no branch and nothing said.
  const kickedOff = useRef(false);
  useEffect(() => {
    if (planDoc === undefined || teamMode) return;
    if (session.branch) return;
    if (session.transcripts.coding.length > 0) return;
    if (streaming) return;
    if (kickedOff.current) return;
    kickedOff.current = true;
    if (session.coordinatorEnabled) return;
    void handleSend(CODING_KICKOFF_MESSAGE);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id, session.branch, session.coordinatorEnabled, session.transcripts.coding.length, streaming, planDoc, teamMode]);

  // QA sent this back for fixes — relay the report as the next message.
  const kickedOffQaFix = useRef(false);
  useEffect(() => {
    if (!session.qaFindingsPending) return;
    if (streaming) return;
    if (kickedOffQaFix.current) return;
    kickedOffQaFix.current = true;
    void (async () => {
      const report = await api.getQaReport(sessionId);
      const findings =
        report.markdown ?? 'QA sent this back for fixes, but the report content could not be loaded — check the QA tab for details.';
      void handleSend(
        `QA sent this back for fixes. Please address the findings below, then stop for review as usual once done:\n\n${findings}`
      );
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id, session.qaFindingsPending, streaming]);

  // Requirements/plan were revised and reconciled after a mid-coding
  // send-back — pick the conversation back up on the same branch.
  const kickedOffReconciliation = useRef(false);
  useEffect(() => {
    if (!session.codingReconciliationPending) return;
    if (streaming) return;
    if (kickedOffReconciliation.current) return;
    kickedOffReconciliation.current = true;
    void handleSend(
      `Requirements and/or the plan were revised and reconciled — see the updated documents above.\n\n` +
        `Original note: ${session.pendingRequirementsRelayNote ?? '(no note provided)'}\n\n` +
        `Continue on this branch, reconciling your checklist and any already-implemented work with the changes.`
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id, session.codingReconciliationPending, streaming]);

  // Auto-run: a mechanical "keep clicking Continue" loop over the checklist,
  // mutually exclusive with the coordinator. Stops the moment anything
  // needs a human: approval, an error, or the attempt cap.
  const plan = session.codingPlan;
  const allStepsDone = plan ? plan.every((s) => s.status === 'done') : true;
  const approved = Boolean(session.codingApprovedAt);
  const autoRunAttempts = useRef(0);
  useEffect(() => {
    if (!autoRun) return;
    if (session.coordinatorEnabled) return;
    if (streaming) return;
    if (error) return;
    if (approved) return;
    if (!plan || allStepsDone) return;
    if (autoRunAttempts.current >= MAX_AUTO_RUN_ATTEMPTS) {
      setAutoRun(false);
      return;
    }
    autoRunAttempts.current += 1;
    void handleSend('Continue with the next step.');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRun, session.coordinatorEnabled, approved, streaming, error, plan, allStepsDone]);

  const entries = streaming ? [...session.transcripts.coding, ...overlay] : session.transcripts.coding;
  const hasCommits = Boolean(session.branch) && (diffData?.commits.length ?? 0) > 0;
  const canContinue = Boolean(plan) && !allStepsDone && !streaming && !approved && !teamMode;
  const busy = streaming || teamActive;
  const canStartTeam =
    teamMode && !teamActive && !approved && (teamStatus === 'not_started' || teamStatus === 'interrupted' || teamStatus === 'needs_attention');

  const leadChat = (
    <ChatPane
      entries={entries}
      onSend={handleSend}
      disabled={streaming || approved || !teamFinished}
      streaming={streaming}
      runningTool={runningTool}
      agent={TEAM_LEAD_PERSONA}
      emptyHint={`The team's work is merged on ${session.branch ?? 'the session branch'}. Ask ${TEAM_LEAD_PERSONA.name} for any changes, or approve the diff.`}
      placeholder={
        approved
          ? 'Coding approved — read only.'
          : !teamFinished
            ? `${TEAM_LEAD_PERSONA.name} takes follow-ups once the team has finished…`
            : `Ask ${TEAM_LEAD_PERSONA.name} for changes, or approve the diff…`
      }
    />
  );

  return (
    <StageLayout
      toolbar={
        <>
          <CoordinatorControl session={session} streaming={streaming} />
          {session.branch && (
            <Pill tone="blue">
              <GitBranch className="w-3 h-3" />
              {session.branch}
            </Pill>
          )}
        </>
      }
      chat={
        teamMode ? (
          <div className="flex flex-col flex-1 min-h-0 gap-3">
            <div className="flex-shrink-0 inline-flex self-start rounded-lg border border-gray-200 bg-white p-0.5 text-sm">
              <button
                type="button"
                onClick={() => setView('team')}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1 ${view === 'team' ? 'bg-indigo-50 text-indigo-700 font-medium' : 'text-gray-600 hover:text-gray-900'}`}
              >
                <Users className="w-4 h-4" />
                Team board
                {teamActive && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              </button>
              <button
                type="button"
                onClick={() => setView('lead')}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1 ${view === 'lead' ? 'bg-indigo-50 text-indigo-700 font-medium' : 'text-gray-600 hover:text-gray-900'}`}
                title={teamFinished ? undefined : `${TEAM_LEAD_PERSONA.name} takes follow-ups once the team has finished`}
              >
                <MessageSquare className="w-4 h-4" />
                Chat with {TEAM_LEAD_PERSONA.name} (lead)
              </button>
            </div>
            {view === 'team' ? (
              <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar pr-1">
                <CodingTeamBoard
                  workstreams={planDoc?.workstreams ?? []}
                  members={codingTeam?.members ?? null}
                  teamStatus={teamStatus}
                  steps={plan ?? []}
                  branch={session.branch}
                  entriesFor={entriesFor}
                  runningTools={team.runningTools}
                  canStart={canStartTeam}
                  starting={team.running}
                  onStart={startTeam}
                />
                {teamFinished && (
                  <Notice tone={teamStatus === 'done' ? 'green' : 'amber'}>
                    {teamStatus === 'done'
                      ? `Everyone's work is merged. Review the diff, then approve it — or ask ${TEAM_LEAD_PERSONA.name} for changes.`
                      : `Not everything merged — resume the team to retry, or ask ${TEAM_LEAD_PERSONA.name} to finish it on the merged branch.`}{' '}
                    <button type="button" className="font-medium underline" onClick={() => setView('lead')}>
                      Chat with {TEAM_LEAD_PERSONA.name}
                    </button>
                  </Notice>
                )}
              </div>
            ) : (
              leadChat
            )}
            <ErrorText>{team.error ?? error}</ErrorText>
          </div>
        ) : (
        <div className="flex flex-col flex-1 min-h-0 gap-3">
          {plan && plan.length > 0 && (
            <div className="flex-shrink-0 space-y-2">
              <CodingPlanChecklist steps={plan} />
              {canContinue && (
                <div className="flex flex-wrap items-center gap-4">
                  <Button size="sm" variant="blue" onClick={() => handleSend('Continue with the next step.')}>
                    <Play />
                    Continue to next step
                  </Button>
                  <label
                    className="flex items-center gap-2 text-sm text-gray-700"
                    title={
                      session.coordinatorEnabled
                        ? `${COORDINATOR_PERSONA.name} is already driving this session — turn the coordinator off to use this.`
                        : 'Continue through each remaining step without clicking — still stops for your approval before QA.'
                    }
                  >
                    <Switch
                      checked={autoRun}
                      disabled={session.coordinatorEnabled}
                      onCheckedChange={(checked) => {
                        autoRunAttempts.current = 0;
                        setAutoRun(checked);
                      }}
                    />
                    Auto-run remaining steps
                  </label>
                </div>
              )}
            </div>
          )}
          <ChatPane
            entries={entries}
            onSend={handleSend}
            disabled={streaming || approved || autoRun}
            streaming={streaming}
            runningTool={runningTool}
            agent={AGENT}
            emptyHint={`${AGENT.name} implements the approved plan on a new branch.`}
            placeholder={
              approved
                ? 'Coding approved — read only.'
                : autoRun
                  ? 'Auto-running remaining steps — turn it off to type a message…'
                  : session.branch
                    ? 'Ask for changes, or approve the diff…'
                    : `Ask ${AGENT.name} to implement the approved plan…`
            }
          />
          <ErrorText>{error}</ErrorText>
        </div>
        )
      }
      document={
        <div className="flex flex-col flex-1 min-h-0 bg-white rounded-lg border border-gray-200 shadow-sm">
          <div className="px-4 py-3 border-b border-gray-100 flex-shrink-0">
            <h2 className="text-sm font-semibold text-gray-900">Diff against the base branch</h2>
            {diffData?.stat && <div className="text-xs text-gray-500 font-mono truncate">{diffData.stat.trim().split('\n').pop()}</div>}
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-4 space-y-4">
            <DiffViewer diff={diffData?.diff ?? null} />
            {diffData && diffData.commits.length > 0 && (
              <div>
                <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Commits</div>
                <ul className="space-y-1">
                  {diffData.commits.map((c) => (
                    <li key={c.hash} className="flex items-start gap-2 text-sm text-gray-700">
                      <GitCommit className="w-4 h-4 mt-0.5 text-gray-400 flex-shrink-0" />
                      <span className="font-mono text-xs text-gray-500 mt-0.5">{c.hash.slice(0, 8)}</span>
                      <span>{c.message}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
          <div className="flex-shrink-0 px-4 pb-4">
            {plan && !allStepsDone && !approved && (
              <Notice tone="amber">
                {plan.filter((s) => s.status === 'done').length} of {plan.length} planned steps done — approving now sends
                this partial implementation to QA.
              </Notice>
            )}
            <ApprovalBar
              approveLabel={approved ? 'Approved — QA started' : 'Approve diff and start QA'}
              onApprove={() => approveMutation.mutate()}
              approveDisabled={approved || !hasCommits || busy}
              approveDisabledReason={teamActive ? 'The coding team is still working' : !hasCommits ? 'No commits on a branch yet' : undefined}
              busy={approveMutation.isPending}
              onReject={() => rejectMutation.mutate()}
              rejectDisabled={approved || busy}
              rejectBusy={rejectMutation.isPending}
            />
            {!showSendBackForm ? (
              <Button
                variant="ghost"
                size="sm"
                className="mt-2 text-gray-600"
                onClick={() => setShowSendBackForm(true)}
                disabled={approved || busy}
                title="Reopen Requirements to revise something already partially implemented, without abandoning this branch"
              >
                <Undo2 />
                Send back to Requirements
              </Button>
            ) : (
              <div className="mt-3 space-y-2">
                <label className="block text-xs font-medium text-gray-600">What needs to change in the requirements?</label>
                <textarea
                  value={sendBackNote}
                  onChange={(e) => setSendBackNote(e.target.value)}
                  rows={3}
                  className="w-full px-3 py-2 border border-gray-200 rounded-md text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
                  placeholder="This note is relayed to the requirements agent."
                />
                <ErrorText>{sendBackMutation.error ? (sendBackMutation.error as Error).message : null}</ErrorText>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="blue"
                    onClick={() => sendBackMutation.mutate(sendBackNote)}
                    disabled={!sendBackNote.trim() || sendBackMutation.isPending}
                  >
                    {sendBackMutation.isPending && <Loader2 className="animate-spin" />}
                    {sendBackMutation.isPending ? 'Sending…' : 'Confirm'}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setShowSendBackForm(false);
                      setSendBackNote('');
                    }}
                    disabled={sendBackMutation.isPending}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      }
    />
  );
}
