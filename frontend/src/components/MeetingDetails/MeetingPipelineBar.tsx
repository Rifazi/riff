"use client";

import { useState } from 'react';
import Link from 'next/link';
import { ArrowRight, Check, ChevronRight, ClipboardList, Code2, ListChecks, Loader2, Lock, Plus, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useAgentServerHealth } from '@/components/DevSessions/AgentServerBanner';
import type { SessionRecord } from '@/lib/dev-sessions/types';
import {
  hasStageActivity,
  isStageCompleted,
  isStageReached,
  sessionHref,
  STAGE_LABEL,
  stageGroupFor,
  type StageGroup,
} from '@/lib/dev-sessions/stage';
import { CreateRequirementsDialog, useMeetingSessions, type MeetingRequirementsContext } from './CreateRequirementsDialog';

const STEPS: { group: StageGroup; label: string; icon: typeof ClipboardList }[] = [
  { group: 'requirements', label: 'Requirements', icon: ClipboardList },
  { group: 'plan', label: 'Plan', icon: ListChecks },
  { group: 'coding', label: 'Code', icon: Code2 },
  { group: 'qa', label: 'QA', icon: ShieldCheck },
];

function StepChip({
  step,
  session,
  isNext,
}: {
  step: (typeof STEPS)[number];
  session: SessionRecord | null;
  isNext: boolean;
}) {
  const Icon = step.icon;
  const reached = session ? isStageReached(session, step.group) : step.group === 'requirements';
  const completed = session ? isStageCompleted(session, step.group) : false;
  const active = session ? hasStageActivity(session, step.group) : false;
  const status = !session ? (step.group === 'requirements' ? 'Start here' : 'Locked') : completed ? 'Done' : active ? 'In progress' : reached ? 'Ready' : 'Locked';

  const content = (
    <div
      className={`flex items-center gap-2 rounded-md border px-2.5 py-1.5 transition-colors ${
        completed
          ? 'border-green-200 bg-green-50'
          : isNext
            ? 'border-purple-300 bg-purple-50 ring-1 ring-purple-200'
            : reached
              ? 'border-gray-200 bg-white hover:bg-gray-50'
              : 'border-gray-200 bg-gray-50 opacity-60'
      }`}
    >
      <div
        className={`w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 ${
          completed ? 'bg-green-600 text-white' : isNext ? 'bg-purple-600 text-white' : reached ? 'bg-gray-200 text-gray-700' : 'bg-gray-200 text-gray-400'
        }`}
      >
        {completed ? <Check className="w-3.5 h-3.5" /> : reached ? <Icon className="w-3.5 h-3.5" /> : <Lock className="w-3 h-3" />}
      </div>
      <div className="leading-tight">
        <div className="text-sm font-medium text-gray-900">{step.label}</div>
        <div className="text-[11px] text-gray-500">{status}</div>
      </div>
    </div>
  );

  if (session && reached) {
    return (
      <Link href={sessionHref(session.id, step.group)} title={`Open ${step.label}`}>
        {content}
      </Link>
    );
  }
  return content;
}

/**
 * The "what happens after transcription" strip across the top of a meeting:
 * meeting → requirements → plan → code → QA, driven by Dev Sessions.
 */
export function MeetingPipelineBar({ context, hasTranscript }: { context: MeetingRequirementsContext; hasTranscript: boolean }) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const { data: healthy } = useAgentServerHealth();
  const { data: sessions, isLoading } = useMeetingSessions(context.meetingId);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const session = sessions?.find((s) => s.id === selectedId) ?? sessions?.[0] ?? null;
  const nextGroup = session ? stageGroupFor(session) : 'requirements';
  const finished = session?.stage === 'done';
  const abandoned = session?.stage === 'abandoned';

  return (
    <div className="flex-shrink-0 border-b border-gray-200 bg-gradient-to-r from-purple-50/70 via-white to-blue-50/70 px-4 py-2.5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-gray-900">
            {session ? 'Build from this meeting' : 'Next: turn this meeting into working software'}
          </div>
          <div className="text-xs text-gray-500">
            {healthy === false
              ? 'The agent server is starting or unavailable — see Dev Sessions for details.'
              : session
                ? `${session.appName} · ${STAGE_LABEL[session.stage] ?? session.stage}`
                : 'Agents draft requirements from the transcript, then plan, code and QA it — you approve each step.'}
          </div>
        </div>

        <div className="flex items-center gap-1">
          {STEPS.map((step, i) => (
            <div key={step.group} className="flex items-center gap-1">
              {i > 0 && <ChevronRight className="w-3.5 h-3.5 text-gray-300 flex-shrink-0" />}
              <StepChip step={step} session={session} isNext={!finished && !abandoned && step.group === nextGroup} />
            </div>
          ))}
        </div>

        <div className="flex items-center gap-2 ml-auto">
          {sessions && sessions.length > 1 && (
            <Select value={session?.id} onValueChange={setSelectedId}>
              <SelectTrigger className="h-8 w-48 bg-white text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {sessions.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.title} · {s.appName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {isLoading && healthy ? (
            <Loader2 className="w-4 h-4 animate-spin text-gray-400" />
          ) : session ? (
            <>
              <Button size="sm" variant="outline" className="bg-white" onClick={() => setDialogOpen(true)} disabled={!hasTranscript} title="Start another session from this meeting">
                <Plus />
                New
              </Button>
              <Button size="sm" className="bg-purple-600 hover:bg-purple-700 text-white" asChild>
                <Link href={sessionHref(session.id, nextGroup)}>
                  {finished ? 'View QA report' : abandoned ? 'Open session' : `Continue: ${STEPS.find((s) => s.group === nextGroup)?.label}`}
                  <ArrowRight />
                </Link>
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              className="bg-purple-600 hover:bg-purple-700 text-white"
              onClick={() => setDialogOpen(true)}
              disabled={!hasTranscript}
              title={hasTranscript ? 'Create requirements from this transcript' : 'No transcript yet'}
            >
              <ClipboardList />
              Create requirements
              <ArrowRight />
            </Button>
          )}
        </div>
      </div>

      <CreateRequirementsDialog open={dialogOpen} onOpenChange={setDialogOpen} context={context} />
    </div>
  );
}
