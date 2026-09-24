'use client';

import { Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, NotebookPen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/dev-sessions/api';
import { SESSIONS_HREF, STAGE_GROUPS, STAGE_LABEL, stageGroupFor, type StageGroup } from '@/lib/dev-sessions/stage';
import { ErrorText, LoadingState, PageShell, Pill } from '@/components/DevSessions/PageShell';
import { StageStepper } from '@/components/DevSessions/StageStepper';
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

  const back = (
    <Button variant="outline" asChild>
      <Link href={SESSIONS_HREF}>
        <ArrowLeft />
        All sessions
      </Link>
    </Button>
  );

  if (!sessionId || error || !session) {
    return (
      <PageShell title="Dev Session" actions={back}>
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
          <span className="font-mono">{session.sessionKey}</span>
          <Pill>{session.appName}</Pill>
          <Pill tone={session.stage === 'abandoned' ? 'red' : session.stage === 'done' ? 'green' : 'blue'}>
            {STAGE_LABEL[session.stage] ?? session.stage}
          </Pill>
          {session.sourceMeeting && (
            <Link
              href={`/meeting-details?id=${encodeURIComponent(session.sourceMeeting.meetingId)}`}
              className="inline-flex items-center gap-1 text-blue-600 hover:underline"
            >
              <NotebookPen className="w-3.5 h-3.5" />
              From meeting: {session.sourceMeeting.meetingTitle || 'Untitled meeting'}
            </Link>
          )}
        </span>
      }
      actions={back}
    >
      <div className="flex-shrink-0 mb-3">
        <StageStepper session={session} current={stage} />
      </div>
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
