'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { GitBranch, GitCommit, Loader2, Play, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/dev-sessions/api';
import type { AttachmentInput, CodingTeamMember, SessionRecord } from '@/lib/dev-sessions/types';
import { useAgentTurnStream } from '@/lib/dev-sessions/useAgentTurnStream';
import { AGENT_PERSONAS, COORDINATOR_PERSONA, TEAM_LEAD_PERSONA } from '@/lib/dev-sessions/agents';
import { useTeamRun } from '@/lib/dev-sessions/useTeamRun';
import { autoRunStopReason, progressOf } from '@/lib/dev-sessions/auto-run';
import { sessionHref } from '@/lib/dev-sessions/stage';
import { ChatPane } from '../ChatPane';
import { ApprovalBar } from '../ApprovalBar';
import { CoordinatorControl } from '../CoordinatorControl';
import { CodingPlanChecklist } from '../CodingPlanChecklist';
import { CodingTeamPanel } from '../CodingTeam';
import { DiffViewer } from '../DiffViewer';
import { ErrorText, Notice, Pill } from '../PageShell';
import { StageLayout } from './StageLayout';

const AGENT = AGENT_PERSONAS.coding;

// Generous cap on consecutive auto-continues. A turn that makes no progress
// already stops auto-run (see autoRunStopReason) — this only bounds a plan
// that keeps shuffling step statuses without ever finishing.
const MAX_AUTO_RUN_ATTEMPTS = 20;
const CONTINUE_MESSAGE = 'Continue with the next step.';
const CODING_KICKOFF_MESSAGE = 'Please implement the approved plan.';

// Client-side twin of the server's compactQaFindings (sessions/qa-findings.ts)
// for when /qa/findings isn't available: result, failing checks, the
// unchecked criteria / [blocking] lines and the non-blocking notes — never
// the whole report.
function compactQaReport(markdown: string): string {
  const field = (key: string) => markdown.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1].trim();
  const failed = [
    ['lint', 'lint'],
    ['unit tests', 'unit-tests'],
    ['integration tests', 'integration-tests'],
  ]
    .filter(([, key]) => field(key) === 'fail')
    .map(([name]) => name);
  const findings = markdown
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^- \[ \]/.test(l) || /^- \[blocking\]/i.test(l))
    .map((l) => l.replace(/^- \[(?: |blocking)\]\s*/i, ''));
  const notes = markdown
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^- \[(note|nit)\]/i.test(l))
    .map((l) => l.replace(/^- \[(?:note|nit)\]\s*/i, ''));
  let text = `QA result: ${field('result') ?? '?'}`;
  if (failed.length > 0) text += ` — failing checks: ${failed.join(', ')}`;
  text += findings.length > 0 ? `\n\nFix:\n${findings.map((f) => `- ${f}`).join('\n')}` : '\n\nNo blocking findings were listed.';
  if (notes.length > 0) {
    text += `\n\nAlso address (non-blocking, but QA wants these acted on):\n${notes.map((n) => `- ${n}`).join('\n')}`;
  }
  return text;
}

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
  // Why auto-run last stopped on its own, shown until it's restarted.
  const [autoRunStopped, setAutoRunStopped] = useState<string | null>(null);

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

  // stepTurn: an automatic "do the next checklist step" message (kickoff,
  // Continue, auto-run) — the only kind the server may route to the light
  // model when the step is tagged light. Anything the human types isn't one.
  const handleSend = (message: string, attachments?: AttachmentInput[], stepTurn = false) => {
    setAutoRunStopped(null);
    return send(
      `/api/sessions/${sessionId}/coding/message`,
      message,
      refresh,
      (event) => {
        // Refresh on every tool result so the branch, diff and commits appear
        // as the agent works instead of only when the whole turn finishes.
        if (event.type === 'tool_result') {
          queryClient.invalidateQueries({ queryKey: ['session', sessionId] });
          queryClient.invalidateQueries({ queryKey: ['coding-diff', sessionId] });
        }
      },
      attachments,
      stepTurn ? { stepTurn: true } : undefined
    );
  };

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
    void handleSend(CODING_KICKOFF_MESSAGE, undefined, true);
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
      // Only what needs fixing — the full report stays in the QA tab. If the
      // findings can't be fetched (e.g. an agent server started before
      // /qa/findings existed), trim the full report here rather than relay it.
      const text = await api
        .getQaFindings(sessionId)
        .then((r) => r.text)
        .catch(() =>
          api
            .getQaReport(sessionId)
            .then((r) => (r.markdown ? compactQaReport(r.markdown) : null))
            .catch(() => null)
        );
      const findings =
        text ?? 'QA sent this back for fixes, but the findings could not be loaded — check the QA tab for details.';
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
  // mutually exclusive with the coordinator. Driven as an explicit loop so
  // each turn's outcome is checked against the refetched session before the
  // next one — it stops the moment anything needs a human: approval, a failed
  // turn, a question, a turn that made no progress, or the attempt cap.
  const plan = session.codingPlan;
  const allStepsDone = plan ? plan.every((s) => s.status === 'done') : true;
  const approved = Boolean(session.codingApprovedAt);
  const autoRunActive = useRef(false);
  useEffect(
    () => () => {
      autoRunActive.current = false;
    },
    []
  );

  const stopAutoRun = (reason: string | null) => {
    autoRunActive.current = false;
    setAutoRun(false);
    setAutoRunStopped(reason);
  };

  const fetchSession = () =>
    queryClient.fetchQuery({ queryKey: ['session', sessionId], queryFn: () => api.getSession(sessionId), staleTime: 0 });
  const fetchCommitCount = (branch: string | null) =>
    branch
      ? queryClient
          .fetchQuery({ queryKey: ['coding-diff', sessionId, branch], queryFn: () => api.getCodingDiff(sessionId), staleTime: 0 })
          .then((d) => d.commits.length)
          .catch(() => 0)
      : Promise.resolve(0);

  const runAutoLoop = async () => {
    autoRunActive.current = true;
    setAutoRun(true);
    setAutoRunStopped(null);
    let current = session;
    let commits = await fetchCommitCount(current.branch);
    for (let attempt = 0; attempt < MAX_AUTO_RUN_ATTEMPTS; attempt++) {
      if (!autoRunActive.current) return;
      if (current.coordinatorEnabled) return stopAutoRun(`${COORDINATOR_PERSONA.name} took over this session.`);
      if (current.codingApprovedAt) return stopAutoRun(null);
      if (!current.codingPlan || current.codingPlan.every((s) => s.status === 'done')) return stopAutoRun(null);

      const before = progressOf(current, commits);
      const turn = await handleSend(CONTINUE_MESSAGE, undefined, true);
      try {
        current = await fetchSession();
      } catch (err) {
        return stopAutoRun(`couldn't reload the session — ${err instanceof Error ? err.message : String(err)}`);
      }
      commits = await fetchCommitCount(current.branch);
      // Turned off mid-turn: that turn was allowed to finish, nothing more.
      if (!autoRunActive.current) return;
      const reason = autoRunStopReason(turn, before, progressOf(current, commits), current);
      if (reason) return stopAutoRun(reason);
    }
    stopAutoRun(`it hit the limit of ${MAX_AUTO_RUN_ATTEMPTS} steps in a row — check the checklist, then turn it back on to keep going.`);
  };

  const entries = streaming ? [...session.transcripts.coding, ...overlay] : session.transcripts.coding;
  const hasCommits = Boolean(session.branch) && (diffData?.commits.length ?? 0) > 0;
  const canContinue = Boolean(plan) && !allStepsDone && !streaming && !approved && !teamMode;
  // The switch stays up for the whole run (turns included) so it can always
  // be turned off.
  const showStepControls = canContinue || autoRun;
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
            <CodingTeamPanel
              workstreams={planDoc?.workstreams ?? []}
              members={codingTeam?.members ?? null}
              teamStatus={teamStatus}
              teamFinished={teamFinished}
              steps={plan ?? []}
              branch={session.branch}
              entriesFor={entriesFor}
              runningTools={team.runningTools}
              canStart={canStartTeam}
              starting={team.running}
              onStart={startTeam}
              leadChat={leadChat}
            />
            <ErrorText>{team.error ?? error}</ErrorText>
          </div>
        ) : (
        <div className="flex flex-col flex-1 min-h-0 gap-3">
          {plan && plan.length > 0 && (
            <div className="flex-shrink-0 space-y-2">
              <CodingPlanChecklist steps={plan} />
              {showStepControls && (
                <div className="flex flex-wrap items-center gap-4">
                  {!autoRun && (
                    <Button
                      size="sm"
                      variant="blue"
                      onClick={() => void handleSend(CONTINUE_MESSAGE, undefined, true)}
                    >
                      <Play />
                      Continue to next step
                    </Button>
                  )}
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
                      onCheckedChange={(checked) =>
                        checked
                          ? void runAutoLoop()
                          : stopAutoRun(streaming ? 'you turned it off. The step already running will finish, then nothing more is sent.' : null)
                      }
                    />
                    Auto-run remaining steps
                  </label>
                </div>
              )}
              {autoRunStopped && !autoRun && <Notice tone="amber">Auto-run stopped: {autoRunStopped}</Notice>}
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
