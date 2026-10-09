'use client';

import { Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import { ExternalLink, NotebookPen } from 'lucide-react';
import { BackButton } from '@/components/BackButton';
import { api } from '@/lib/dev-sessions/api';
import { SESSIONS_HREF, STAGE_GROUPS, STAGE_LABEL, stageGroupFor, type StageGroup } from '@/lib/dev-sessions/stage';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ErrorText, LoadingState, PageShell } from '@/components/DevSessions/PageShell';
import { StageStepper } from '@/components/DevSessions/StageStepper';
import { SessionReferenceDocsButton } from '@/components/DevSessions/ReferenceDocs';
import { SplitPartStrip } from '@/components/DevSessions/SplitPanel';
import { RequirementsStage } from '@/components/DevSessions/stages/RequirementsStage';
import { PlanStage } from '@/components/DevSessions/stages/PlanStage';
import { CodingStage } from '@/components/DevSessions/stages/CodingStage';
import { QaStage } from '@/components/DevSessions/stages/QaStage';

const STAGES = { requirements: RequirementsStage, plan: PlanStage, coding: CodingStage, qa: QaStage } as const;

function isStageGroup(value: string | null): value is StageGroup {
  return STAGE_GROUPS.some((s) => s.group === value);
}

function SessionView() {
  const searchParams = useSearchParams();
  const sessionId = searchParams.get('id');
  const stageParam = searchParams.get('stage');

  const { data: session, error } = useQuery({
    queryKey: ['session', sessionId],
    queryFn: () => api.getSession(sessionId!),
    enabled: Boolean(sessionId),
  });

  const back = <BackButton fallbackHref={SESSIONS_HREF} />;

  if (!sessionId || error || !session) {
    return (
      <PageShell title="Dev Session" back={back}>
        {!sessionId ? <ErrorText>No session selected.</ErrorText> : error ? <ErrorText>{(error as Error).message}</ErrorText> : <LoadingState />}
      </PageShell>
    );
  }

  // Landing without a stage (e.g. from a meeting) opens whichever stage is live.
  const stage = isStageGroup(stageParam) ? stageParam : stageGroupFor(session);
  const Stage = STAGES[stage];

  return (
    <PageShell
      fill
      title={session.title}
      subtitle={
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-mono">{session.ticket ?? session.sessionKey}</span>
          <Badge variant="secondary">{session.appName}</Badge>
          <Badge
            variant={
              session.stage === 'abandoned'
                ? 'destructive'
                : session.stage === 'done'
                  ? 'success'
                  : session.stage === 'split'
                    ? 'secondary'
                    : 'info'
            }
          >
            {STAGE_LABEL[session.stage] ?? session.stage}
          </Badge>
          {session.sourceMeeting && (
            <Link
              href={
                session.sourceMeeting.kind === 'journal'
                  ? `/journal/notebook?id=${encodeURIComponent(session.sourceMeeting.meetingId)}`
                  : `/meeting-details?id=${encodeURIComponent(session.sourceMeeting.meetingId)}`
              }
              className="inline-flex items-center gap-1 text-primary hover:underline"
            >
              <NotebookPen className="w-3.5 h-3.5" />
              {session.sourceMeeting.kind === 'journal' ? 'From journal' : 'From meeting'}:{' '}
              {session.sourceMeeting.meetingTitle || 'Untitled'}
            </Link>
          )}
        </span>
      }
      back={back}
      actions={
        <>
          <Button
            size="icon"
            variant="ghost"
            onClick={() => invoke('open_session_window', { sessionId: session.id, title: session.title })}
            aria-label="Open in new window"
            title="Open in new window"
          >
            <ExternalLink className="w-4 h-4" />
          </Button>
          <SessionReferenceDocsButton session={session} />
        </>
      }
    >
      <div className="flex-shrink-0 mb-3">
        <StageStepper session={session} current={stage} />
      </div>
      {session.splitFrom && (
        <div className="flex-shrink-0 mb-3">
          <SplitPartStrip session={session} />
        </div>
      )}
      <Stage key={`${session.id}-${stage}`} session={session} />
    </PageShell>
  );
}

export default function DevSessionPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <SessionView />
    </Suspense>
  );
}
