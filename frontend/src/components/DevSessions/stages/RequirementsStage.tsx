'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/dev-sessions/api';
import type { AttachmentInput, SessionRecord } from '@/lib/dev-sessions/types';
import { useAgentTurnStream } from '@/lib/dev-sessions/useAgentTurnStream';
import { AGENT_PERSONAS } from '@/lib/dev-sessions/agents';
import { sessionHref, stageGroupFor } from '@/lib/dev-sessions/stage';
import { meetingKickoffMessage, splitKickoffMessage, THEME_MIGRATION_KICKOFF, themeMigrationKickoffMessage } from '@/lib/dev-sessions/meeting';
import { ChatPane } from '../ChatPane';
import { ApprovalBar } from '../ApprovalBar';
import { CoordinatorControl } from '../CoordinatorControl';
import { DocumentCard } from '../DocumentCard';
import { SplitLinks, SplitProposalCard } from '../SplitPanel';
import { ThemeProposalPanel } from '../ThemeProposalPanel';
import { Badge } from '@/components/ui/badge';
import { ErrorText, Notice } from '../PageShell';
import { StageLayout } from './StageLayout';

const AGENT = AGENT_PERSONAS.requirements;

export function RequirementsStage({ session }: { session: SessionRecord }) {
  const sessionId = session.id;
  const queryClient = useQueryClient();
  const router = useRouter();
  const kickoff = useSearchParams().get('kickoff');
  const { data: doc } = useQuery({
    queryKey: ['requirements-doc', sessionId, session.requirementsPath],
    queryFn: () => api.getRequirementsDoc(sessionId),
  });

  const { overlay, streaming, runningTool, error, send, runCoordinator } = useAgentTurnStream();

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['session', sessionId] });
    queryClient.invalidateQueries({ queryKey: ['sessions'] });
    queryClient.invalidateQueries({ queryKey: ['requirements-doc', sessionId] });
  };

  const approveMutation = useMutation({
    mutationFn: () => api.approveRequirements(sessionId),
    onSuccess: () => {
      refresh();
      // Plan is the next actionable stage the moment requirements are approved.
      router.push(sessionHref(sessionId, 'plan'));
    },
  });

  const rejectMutation = useMutation({ mutationFn: () => api.rejectRequirements(sessionId), onSuccess: refresh });

  // Accepting creates the child sessions server-side; this page then shows
  // links to them. Keeping it as one tells the agent to carry on.
  const acceptSplitMutation = useMutation({ mutationFn: () => api.acceptSplit(sessionId), onSuccess: refresh });
  const dismissSplitMutation = useMutation({
    mutationFn: () => api.dismissSplit(sessionId),
    onSuccess: () => {
      refresh();
      void handleSend("Let's keep this as one feature — carry on and write a single requirements document.");
    },
  });

  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const editMutation = useMutation({
    mutationFn: (markdownBody: string) => api.updateRequirementsDoc(sessionId, markdownBody),
    onSuccess: () => {
      // Saving over an approved doc reverts it to draft server-side.
      refresh();
      setIsEditing(false);
    },
  });

  // Don't clobber an open manual edit if the agent writes a fresh version.
  useEffect(() => {
    if (!isEditing) setDraft(doc?.body ?? '');
  }, [doc?.body, isEditing]);

  const handleSend = (message: string, attachments?: AttachmentInput[]) =>
    send(`/api/sessions/${sessionId}/requirements/message`, message, refresh, (event) => {
      if (event.type === 'tool_result') queryClient.invalidateQueries({ queryKey: ['requirements-doc', sessionId] });
    }, attachments);

  // Started from a Riff meeting: open the conversation with the
  // transcript automatically. The server attaches the transcript to
  // whichever requirements message comes first and clears the flag.
  const kickedOffMeeting = useRef(false);
  useEffect(() => {
    if (!session.meetingKickoffPending) return;
    if (streaming) return;
    if (kickedOffMeeting.current) return;
    kickedOffMeeting.current = true;
    void handleSend(meetingKickoffMessage(session));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id, session.meetingKickoffPending, streaming]);

  // Created by accepting a split: open with the part's brief, which the
  // server attaches to the first message and then clears.
  const kickedOffSplit = useRef(false);
  useEffect(() => {
    if (!session.splitKickoffPending) return;
    if (streaming) return;
    if (kickedOffSplit.current) return;
    kickedOffSplit.current = true;
    void handleSend(splitKickoffMessage(session));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id, session.splitKickoffPending, streaming]);

  // Started from an app's Theme page to migrate the app onto its theme:
  // open with the migration brief. Only into an empty conversation, so a
  // reload of the same URL never sends it twice.
  const kickedOffThemeMigration = useRef(false);
  useEffect(() => {
    if (kickoff !== THEME_MIGRATION_KICKOFF) return;
    if (session.transcripts.requirements.length > 0 || streaming) return;
    if (kickedOffThemeMigration.current) return;
    kickedOffThemeMigration.current = true;
    void api.getAppTheme(session.appId).then((state) => handleSend(themeMigrationKickoffMessage(state.current?.theme.name ?? 'current')));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id, kickoff, session.transcripts.requirements.length, streaming]);

  // Coordinator auto-start: the moment this stage is reached with
  // coordinator mode on and nothing said yet, drive it automatically.
  const kickedOffCoordinator = useRef(false);
  useEffect(() => {
    if (!session.coordinatorEnabled) return;
    if (session.meetingKickoffPending || session.splitKickoffPending) return;
    if (session.transcripts.requirements.length > 0) return;
    if (streaming) return;
    if (kickedOffCoordinator.current) return;
    kickedOffCoordinator.current = true;
    void runCoordinator(sessionId, refresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id, session.coordinatorEnabled, session.transcripts.requirements.length, streaming]);

  // Coding sent this back for a revision — relay the human's note as the
  // opening message of the reopened conversation. Clears server-side.
  const kickedOffRequirementsRelay = useRef(false);
  useEffect(() => {
    if (!session.requirementsRelayPending) return;
    if (streaming) return;
    if (kickedOffRequirementsRelay.current) return;
    kickedOffRequirementsRelay.current = true;
    void handleSend(
      `Coding sent this back for a requirements revision. Here's the note:\n\n${session.pendingRequirementsRelayNote ?? '(no note provided)'}`
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id, session.requirementsRelayPending, streaming]);

  const entries = streaming ? [...session.transcripts.requirements, ...overlay] : session.transcripts.requirements;
  const isApproved = session.requirementsStatus === 'approved';
  const isSplit = session.stage === 'split';
  const splitBusy = acceptSplitMutation.isPending ? 'accept' : dismissSplitMutation.isPending ? 'dismiss' : null;
  const splitError = (acceptSplitMutation.error ?? dismissSplitMutation.error) as Error | null;
  const codingStarted = Boolean(session.branch);
  const reopenedHere = codingStarted && stageGroupFor(session) === 'requirements';
  const canEdit = Boolean(session.requirementsPath) && (!codingStarted || reopenedHere) && !streaming && !isSplit;

  return (
    <StageLayout
      toolbar={<CoordinatorControl session={session} streaming={streaming} />}
      chat={
        <>
          <ChatPane
            entries={entries}
            onSend={handleSend}
            disabled={streaming || isApproved || isEditing || isSplit}
            streaming={streaming}
            runningTool={runningTool}
            agent={AGENT}
            emptyHint={`Describe what you want to build — ${AGENT.name} will ask questions and write the requirements.`}
            placeholder={
              isSplit
                ? 'Split into separate sessions — read only.'
                : isApproved
                ? 'Requirements approved — read only.'
                : isEditing
                  ? 'Finish or cancel your manual edit first…'
                  : 'Describe what you want to build…'
            }
          />
          <ErrorText>{error}</ErrorText>
        </>
      }
      document={
        <DocumentCard
          title="Requirements document"
          subtitle={doc?.markdown ? session.requirementsPath : null}
          markdown={doc?.markdown}
          emptyText={
            canEdit
              ? `Not written yet — keep talking to ${AGENT.name}, or click "Write requirements" to write it directly.`
              : `Not written yet — keep talking to ${AGENT.name}.`
          }
          badge={
            isSplit ? (
              <Badge variant="secondary">Split</Badge>
            ) : isApproved ? (
              <Badge variant="success">Approved</Badge>
            ) : !reopenedHere && !canEdit && codingStarted ? (
              <Badge variant="secondary" title="Coding already started from this doc">
                Locked — coding started
              </Badge>
            ) : session.requirementsStatus === 'draft' ? (
              <Badge variant="warning">Draft</Badge>
            ) : null
          }
          notices={
            <>
              <SplitLinks session={session} />
              {session.splitProposal && !isSplit && (
                <SplitProposalCard
                  proposal={session.splitProposal}
                  agentName={AGENT.name}
                  busy={splitBusy}
                  disabled={streaming || isEditing}
                  onAccept={() => acceptSplitMutation.mutate()}
                  onDismiss={() => dismissSplitMutation.mutate()}
                />
              )}
              <ErrorText>{splitError?.message ?? null}</ErrorText>
              <ThemeProposalPanel
                session={session}
                agentName={AGENT.name}
                disabled={streaming}
                onApplied={(result, edited) => {
                  refresh();
                  void handleSend(
                    `I applied the "${result.theme.name}" theme${edited ? ' after adjusting it in the picker' : ''}. It's saved in theme/theme.json, ` +
                      "so that theme change is done. It doesn't need a requirements document or an in-app theme picker."
                  );
                }}
                onDismissed={refresh}
              />
              {reopenedHere && (
                <Notice tone="amber">
                  Reopened mid-coding — branch <code>{session.branch}</code> has existing work. Changes here are
                  reconciled with the plan and coding checklist once re-approved.
                </Notice>
              )}
              {isApproved && canEdit && !isEditing && (
                <Notice>Editing reverts this to draft — you'll need to approve the new text.</Notice>
              )}
            </>
          }
          editing={{
            canEdit: canEdit && doc !== undefined,
            isEditing,
            editLabel: doc?.body == null ? 'Write requirements' : 'Edit',
            draft,
            onDraftChange: setDraft,
            onStart: () => setIsEditing(true),
            onCancel: () => {
              setDraft(doc?.body ?? '');
              setIsEditing(false);
            },
            onSave: () => editMutation.mutate(draft),
            saving: editMutation.isPending,
            error: editMutation.error ? (editMutation.error as Error).message : null,
          }}
          footer={
            <ApprovalBar
              approveLabel={isApproved ? 'Approved' : 'Approve requirements'}
              onApprove={() => approveMutation.mutate()}
              approveDisabled={isApproved || isSplit || !session.requirementsPath || streaming || isEditing}
              approveDisabledReason={!session.requirementsPath ? 'No document written yet' : undefined}
              busy={approveMutation.isPending}
              onReject={() => rejectMutation.mutate()}
              rejectDisabled={isApproved || isSplit || streaming}
              rejectBusy={rejectMutation.isPending}
            />
          }
        />
      }
    />
  );
}
