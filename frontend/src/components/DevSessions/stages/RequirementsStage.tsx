'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/dev-sessions/api';
import type { AttachmentInput, SessionRecord } from '@/lib/dev-sessions/types';
import { useAgentTurnStream } from '@/lib/dev-sessions/useAgentTurnStream';
import { AGENT_PERSONAS } from '@/lib/dev-sessions/agents';
import { sessionHref, stageGroupFor } from '@/lib/dev-sessions/stage';
import { meetingKickoffMessage } from '@/lib/dev-sessions/meeting';
import { ChatPane } from '../ChatPane';
import { ApprovalBar } from '../ApprovalBar';
import { CoordinatorControl } from '../CoordinatorControl';
import { DocumentCard } from '../DocumentCard';
import { ErrorText, Notice, Pill } from '../PageShell';
import { StageLayout } from './StageLayout';

const AGENT = AGENT_PERSONAS.requirements;

export function RequirementsStage({ session }: { session: SessionRecord }) {
  const sessionId = session.id;
  const queryClient = useQueryClient();
  const router = useRouter();
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

  // Coordinator auto-start: the moment this stage is reached with
  // coordinator mode on and nothing said yet, drive it automatically.
  const kickedOffCoordinator = useRef(false);
  useEffect(() => {
    if (!session.coordinatorEnabled) return;
    if (session.meetingKickoffPending) return;
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
  const codingStarted = Boolean(session.branch);
  const reopenedHere = codingStarted && stageGroupFor(session) === 'requirements';
  const canEdit = Boolean(session.requirementsPath) && (!codingStarted || reopenedHere) && !streaming;

  return (
    <StageLayout
      toolbar={<CoordinatorControl session={session} streaming={streaming} />}
      chat={
        <>
          <ChatPane
            entries={entries}
            onSend={handleSend}
            disabled={streaming || isApproved || isEditing}
            streaming={streaming}
            runningTool={runningTool}
            agent={AGENT}
            emptyHint={`Describe what you want to build — ${AGENT.name} will ask questions and write the requirements.`}
            placeholder={
              isApproved
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
            isApproved ? (
              <Pill tone="green">Approved</Pill>
            ) : !reopenedHere && !canEdit && codingStarted ? (
              <Pill title="Coding already started from this doc">Locked — coding started</Pill>
            ) : session.requirementsStatus === 'draft' ? (
              <Pill tone="amber">Draft</Pill>
            ) : null
          }
          notices={
            <>
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
              approveDisabled={isApproved || !session.requirementsPath || streaming || isEditing}
              approveDisabledReason={!session.requirementsPath ? 'No document written yet' : undefined}
              busy={approveMutation.isPending}
              onReject={() => rejectMutation.mutate()}
              rejectDisabled={isApproved || streaming}
              rejectBusy={rejectMutation.isPending}
            />
          }
        />
      }
    />
  );
}
