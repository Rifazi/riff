'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Loader2, Ticket } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/dev-sessions/api';
import type { AttachmentInput, SessionRecord } from '@/lib/dev-sessions/types';
import { useAgentTurnStream } from '@/lib/dev-sessions/useAgentTurnStream';
import { AGENT_PERSONAS } from '@/lib/dev-sessions/agents';
import { sessionHref, stageGroupFor } from '@/lib/dev-sessions/stage';
import { ChatPane } from '../ChatPane';
import { ExternalAnchor } from '../ExternalAnchor';
import { ApprovalBar } from '../ApprovalBar';
import { CoordinatorControl } from '../CoordinatorControl';
import { DocumentCard } from '../DocumentCard';
import { ErrorText, Notice, Pill } from '../PageShell';
import { StageLayout } from './StageLayout';

const AGENT = AGENT_PERSONAS.plan;

const PLAN_KICKOFF_MESSAGE = 'Please break the approved requirements into a concrete, reviewable step-by-step plan.';

function JiraTickets({
  sessionId,
  doc,
}: {
  sessionId: string;
  doc: Awaited<ReturnType<typeof api.getPlanDoc>>;
}) {
  const queryClient = useQueryClient();
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.getSettings });

  const createMutation = useMutation({
    mutationFn: () => api.createJiraTickets(sessionId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['plan-doc', sessionId] }),
  });

  if (doc.steps.length === 0) return null;

  const jiraConfigured = Boolean(settings?.jira.baseUrl && settings?.jira.hasToken);
  const created = doc.jira?.issues ?? [];
  const createdStepIds = new Set(created.map((issue) => issue.stepId));
  const remaining = doc.steps.filter((step) => !createdStepIds.has(step.id));

  return (
    <div className="mt-3 pt-3 border-t border-gray-100">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-semibold text-gray-900">
          <Ticket className="w-4 h-4" />
          Jira tickets
        </div>
        {jiraConfigured && remaining.length > 0 && (
          <Button size="sm" variant="outline" onClick={() => createMutation.mutate()} disabled={createMutation.isPending}>
            {createMutation.isPending && <Loader2 className="animate-spin" />}
            {createMutation.isPending ? 'Creating…' : `Create ${remaining.length} ticket${remaining.length === 1 ? '' : 's'}`}
          </Button>
        )}
      </div>
      {!jiraConfigured && (
        <div className="text-xs text-gray-500 mt-1">
          Add a Jira base URL, email and API token under Settings → Dev Agents to create one ticket per plan step.
        </div>
      )}
      {created.length > 0 && (
        <ul className="mt-2 space-y-1 text-sm">
          {created.map((issue) => (
            <li key={issue.stepId} className="flex items-center gap-2">
              <ExternalAnchor href={issue.url} className="inline-flex items-center gap-1 text-blue-600 hover:underline font-medium">
                {issue.key}
                <ExternalLink className="w-3 h-3" />
              </ExternalAnchor>
              <span className="text-gray-600 truncate">{issue.title}</span>
            </li>
          ))}
        </ul>
      )}
      {createMutation.data?.errors.map((e) => (
        <ErrorText key={e.stepId}>
          {e.title}: {e.message}
        </ErrorText>
      ))}
      <ErrorText>{createMutation.isError ? (createMutation.error as Error).message : null}</ErrorText>
    </div>
  );
}

export function PlanStage({ session }: { session: SessionRecord }) {
  const sessionId = session.id;
  const queryClient = useQueryClient();
  const router = useRouter();
  const { data: doc } = useQuery({
    queryKey: ['plan-doc', sessionId, session.planPath],
    queryFn: () => api.getPlanDoc(sessionId),
  });

  const { overlay, streaming, runningTool, error, send, runCoordinator } = useAgentTurnStream();

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['session', sessionId] });
    queryClient.invalidateQueries({ queryKey: ['sessions'] });
    queryClient.invalidateQueries({ queryKey: ['plan-doc', sessionId] });
  };

  const approveMutation = useMutation({
    mutationFn: () => api.approvePlan(sessionId),
    onSuccess: () => {
      refresh();
      router.push(sessionHref(sessionId, 'coding'));
    },
  });

  const rejectMutation = useMutation({ mutationFn: () => api.rejectPlan(sessionId), onSuccess: refresh });

  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const editMutation = useMutation({
    mutationFn: (markdownBody: string) => api.updatePlanDoc(sessionId, markdownBody),
    onSuccess: () => {
      refresh();
      setIsEditing(false);
    },
  });

  useEffect(() => {
    if (!isEditing) setDraft(doc?.body ?? '');
  }, [doc?.body, isEditing]);

  const handleSend = (message: string, attachments?: AttachmentInput[]) =>
    send(`/api/sessions/${sessionId}/plan/message`, message, refresh, (event) => {
      if (event.type === 'tool_result') queryClient.invalidateQueries({ queryKey: ['plan-doc', sessionId] });
    }, attachments);

  // Kick this stage off automatically when it's reached with nothing said
  // yet. Coordinator mode (if on) drives this via its own effect instead.
  const kickedOff = useRef(false);
  useEffect(() => {
    if (session.planStatus === 'approved') return;
    if (session.transcripts.plan.length > 0) return;
    if (streaming) return;
    if (kickedOff.current) return;
    kickedOff.current = true;
    if (session.coordinatorEnabled) return;
    void handleSend(PLAN_KICKOFF_MESSAGE);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id, session.planStatus, session.coordinatorEnabled, session.transcripts.plan.length, streaming]);

  const kickedOffCoordinator = useRef(false);
  useEffect(() => {
    if (!session.coordinatorEnabled) return;
    if (session.transcripts.plan.length > 0) return;
    if (streaming) return;
    if (kickedOffCoordinator.current) return;
    kickedOffCoordinator.current = true;
    void runCoordinator(sessionId, refresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id, session.coordinatorEnabled, session.transcripts.plan.length, streaming]);

  // Requirements were revised and re-approved after a mid-coding send-back —
  // relay the note so the plan agent reconciles the checklist against it.
  const kickedOffPlanRelay = useRef(false);
  useEffect(() => {
    if (!session.planRelayPending) return;
    if (streaming) return;
    if (kickedOffPlanRelay.current) return;
    kickedOffPlanRelay.current = true;
    void handleSend(
      `Requirements were revised (see note below) and re-approved while coding was in progress — reconcile the ` +
        `plan and existing coding checklist accordingly.\n\n---\n${session.pendingRequirementsRelayNote ?? '(no note provided)'}`
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id, session.planRelayPending, streaming]);

  const entries = streaming ? [...session.transcripts.plan, ...overlay] : session.transcripts.plan;
  const isApproved = session.planStatus === 'approved';
  const codingStarted = Boolean(session.branch);
  const reopenedHere = codingStarted && stageGroupFor(session) === 'plan';
  const canEdit = Boolean(session.planPath) && (!codingStarted || reopenedHere) && !streaming;

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
            emptyHint={`${AGENT.name} turns the approved requirements into a step-by-step plan.`}
            placeholder={
              isApproved
                ? 'Plan approved — read only.'
                : isEditing
                  ? 'Finish or cancel your manual edit first…'
                  : `Ask ${AGENT.name} to adjust the plan…`
            }
          />
          <ErrorText>{error}</ErrorText>
        </>
      }
      document={
        <DocumentCard
          title="Plan document"
          subtitle={doc?.markdown ? session.planPath : null}
          markdown={doc?.markdown}
          emptyText={
            canEdit
              ? `Not written yet — keep talking to ${AGENT.name}, or click "Write plan" to write it directly.`
              : `Not written yet — keep talking to ${AGENT.name}.`
          }
          badge={
            isApproved ? (
              <Pill tone="green">Approved</Pill>
            ) : !reopenedHere && !canEdit && codingStarted ? (
              <Pill title="Coding already started from this plan">Locked — coding started</Pill>
            ) : session.planStatus === 'draft' ? (
              <Pill tone="amber">Draft</Pill>
            ) : null
          }
          notices={
            <>
              {reopenedHere && (
                <Notice tone="amber">
                  Reopened mid-coding — branch <code>{session.branch}</code> has existing work. Re-approving resumes the
                  same branch; it doesn't start a new one.
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
            editLabel: doc?.body == null ? 'Write plan' : 'Edit',
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
            <>
              <ApprovalBar
                approveLabel={isApproved ? 'Approved' : 'Approve plan'}
                onApprove={() => approveMutation.mutate()}
                approveDisabled={isApproved || !session.planPath || streaming || isEditing}
                approveDisabledReason={!session.planPath ? 'No plan written yet' : undefined}
                busy={approveMutation.isPending}
                onReject={() => rejectMutation.mutate()}
                rejectDisabled={isApproved || streaming}
                rejectBusy={rejectMutation.isPending}
              />
              {isApproved && doc && <JiraTickets sessionId={sessionId} doc={doc} />}
            </>
          }
        />
      }
    />
  );
}
