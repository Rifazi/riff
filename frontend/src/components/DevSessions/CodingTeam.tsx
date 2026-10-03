'use client';

import React, { useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  FolderLock,
  GitMerge,
  Loader2,
  Maximize2,
  Play,
  RotateCcw,
  Users,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import type {
  CodingPlanStep,
  CodingTeamMember,
  PlanStepSummary,
  PlanWorkstream,
  TeamMemberStatus,
  TranscriptEntry,
} from '@/lib/dev-sessions/types';
import { TEAM_LEAD_PERSONA, teamMemberPersona, type TeamPersona } from '@/lib/dev-sessions/agents';
import { AgentAvatar, ChatPane } from './ChatPane';
import { CodingPlanChecklist } from './CodingPlanChecklist';

// ---------------------------------------------------------------- shared

const STATUS_META: Record<TeamMemberStatus, { label: string; variant: NonNullable<BadgeProps['variant']> }> = {
  waiting: { label: 'Waiting', variant: 'secondary' },
  running: { label: 'Working', variant: 'info' },
  merging: { label: 'Merging', variant: 'info' },
  merged: { label: 'Merged', variant: 'success' },
  failed: { label: 'Needs attention', variant: 'destructive' },
  blocked: { label: 'Blocked', variant: 'warning' },
};

function StatusIcon({ status, className = 'w-3 h-3' }: { status: TeamMemberStatus; className?: string }) {
  if (status === 'running') return <Loader2 className={`${className} animate-spin`} />;
  if (status === 'merging') return <GitMerge className={className} />;
  if (status === 'merged') return <CheckCircle2 className={className} />;
  if (status === 'failed' || status === 'blocked') return <AlertTriangle className={className} />;
  return <Clock className={className} />;
}

function StatusPill({ status }: { status: TeamMemberStatus }) {
  const meta = STATUS_META[status];
  return (
    <Badge variant={meta.variant} className="gap-1">
      <StatusIcon status={status} />
      {meta.label}
    </Badge>
  );
}

/** Jack followed by the engineers — the one "this is a team" visual, used on both tabs. */
function TeamFaces({ personas }: { personas: TeamPersona[] }) {
  return (
    <div className="flex items-center flex-shrink-0">
      <AgentAvatar agent={TEAM_LEAD_PERSONA} />
      <div className="flex -space-x-1.5 ml-1">
        {personas.map((p) => (
          <div key={p.name} className="rounded-full ring-2 ring-white">
            <AgentAvatar agent={p} size="sm" />
          </div>
        ))}
      </div>
    </div>
  );
}

function OwnedPaths({ paths }: { paths: string[] }) {
  return (
    <div className="flex flex-wrap items-center gap-1 text-xs text-gray-500">
      <FolderLock className="w-3.5 h-3.5 flex-shrink-0" />
      <span>Owns</span>
      {paths.map((p) => (
        <code key={p} className="text-[11px] bg-gray-100 text-gray-700 rounded px-1.5 py-0.5 break-all">
          {p}
        </code>
      ))}
    </div>
  );
}

function nameOf(id: string, all: PlanWorkstream[]): string {
  const i = all.findIndex((w) => w.id === id);
  return i >= 0 ? teamMemberPersona(i, all[i].title).name : id;
}

function waitsFor(ws: PlanWorkstream, all: PlanWorkstream[]): string | null {
  return ws.dependsOn.length ? ws.dependsOn.map((id) => nameOf(id, all)).join(' & ') : null;
}

// ---------------------------------------------------------------- Plan tab

/** Plan tab: who will build what once the plan is approved. */
export function TeamPlanPanel({ workstreams, steps }: { workstreams: PlanWorkstream[]; steps: PlanStepSummary[] }) {
  const personas = workstreams.map((w, i) => teamMemberPersona(i, w.title));
  const startNow = workstreams.filter((w) => w.dependsOn.length === 0).length;
  const stepTitle = (id: string) => steps.find((s) => s.id === id)?.title ?? id;

  return (
    <div className="rounded-lg border border-gray-200 bg-white">
      <div className="flex items-center gap-3 px-3 py-2.5 border-b border-gray-100">
        <TeamFaces personas={personas} />
        <div className="min-w-0">
          <div className="text-sm font-semibold text-gray-900">Coded by a team of {workstreams.length + 1} agents</div>
          <div className="text-xs text-gray-500">
            {TEAM_LEAD_PERSONA.name} leads · {workstreams.length} engineers, {startNow} starting at once · each owns its
            own files
          </div>
        </div>
      </div>
      <ul className="divide-y divide-gray-100">
        {workstreams.map((ws, i) => {
          const after = waitsFor(ws, workstreams);
          return (
            <li key={ws.id} className="px-3 py-2.5 space-y-1.5">
              <div className="flex items-start gap-2">
                <AgentAvatar agent={personas[i]} size="sm" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-gray-900">
                    <span className="font-medium">{personas[i].name}</span>{' '}
                    <span className="text-gray-500">· {ws.title}</span>
                  </div>
                  <div className="text-xs text-gray-500">{after ? `Starts after ${after}` : 'Starts right away'}</div>
                </div>
              </div>
              <ol className="pl-8 text-xs text-gray-700 space-y-0.5 list-decimal list-inside">
                {ws.stepIds.map((id) => (
                  <li key={id}>{stepTitle(id)}</li>
                ))}
              </ol>
              <div className="pl-8">
                <OwnedPaths paths={ws.ownedPaths} />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------- Coding tab

type TeamStatus = 'not_started' | 'running' | 'done' | 'needs_attention' | 'interrupted';

function MemberLog({
  member,
  persona,
  lineup,
  entries,
  runningTool,
}: {
  member: CodingTeamMember;
  persona: TeamPersona;
  lineup: CodingTeamMember[];
  entries: TranscriptEntry[];
  runningTool: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const active = member.status === 'running' || member.status === 'merging';
  const after = waitsFor(member, lineup);

  const pane = (expandedView: boolean) => (
    <ChatPane
      readOnly
      entries={entries}
      disabled
      streaming={active}
      runningTool={runningTool}
      agent={persona}
      className={expandedView ? 'border-0 shadow-none rounded-none' : undefined}
      emptyHint={
        member.status === 'waiting' && after
          ? `${persona.name} starts once ${after} ${after.includes('&') ? 'have' : 'has'} merged.`
          : `${persona.name} hasn't started yet.`
      }
      headerActions={
        <>
          <StatusPill status={member.status} />
          {!expandedView && (
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8"
              onClick={() => setExpanded(true)}
              title={`Open ${persona.name}'s full log`}
            >
              <Maximize2 className="w-4 h-4" />
            </Button>
          )}
        </>
      }
      readOnlyNote={
        member.status === 'merging'
          ? `Merging ${member.branch} into the session branch…`
          : `${persona.name}'s full log — read only. ${TEAM_LEAD_PERSONA.name} takes follow-ups once the team is done.`
      }
    />
  );

  return (
    <>
      {pane(false)}
      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent className="max-w-5xl w-[95vw] h-[88vh] p-0 gap-0 flex flex-col overflow-hidden">
          <DialogTitle className="sr-only">{persona.name}&apos;s log</DialogTitle>
          {pane(true)}
        </DialogContent>
      </Dialog>
    </>
  );
}

export interface CodingTeamPanelProps {
  /** Before the team starts, the lineup comes from the approved plan. */
  workstreams: PlanWorkstream[];
  members: CodingTeamMember[] | null;
  teamStatus: TeamStatus;
  teamFinished: boolean;
  steps: CodingPlanStep[];
  branch: string | null;
  entriesFor: (member: CodingTeamMember) => TranscriptEntry[];
  runningTools: Record<string, string | null>;
  canStart: boolean;
  starting: boolean;
  onStart: () => void;
  /** The lead's chat (the same ChatPane the single-agent Coding tab uses). */
  leadChat: React.ReactNode;
}

const LEAD_TAB = '__lead__';

/**
 * Coding tab in team mode: a summary card, one tab per engineer plus the
 * lead, and the selected member's full log in the same chat UI used for
 * every other agent.
 */
export function CodingTeamPanel(props: CodingTeamPanelProps) {
  const {
    workstreams,
    members,
    teamStatus,
    teamFinished,
    steps,
    branch,
    entriesFor,
    runningTools,
    canStart,
    starting,
    onStart,
    leadChat,
  } = props;
  const lineup: CodingTeamMember[] =
    members ??
    workstreams.map((ws) => ({
      ...ws,
      branch: '',
      status: 'waiting',
      note: null,
      startedAt: null,
      finishedAt: null,
      transcript: [],
    }));
  const personas = lineup.map((m, i) => teamMemberPersona(i, m.title));

  const [picked, setPicked] = useState<string | null>(null);
  const defaultTab = teamFinished
    ? LEAD_TAB
    : ((lineup.find((m) => m.status === 'running') ?? lineup[0])?.id ?? LEAD_TAB);
  const selected = picked ?? defaultTab;
  const selectedIndex = lineup.findIndex((m) => m.id === selected);
  const member = selectedIndex >= 0 ? lineup[selectedIndex] : null;

  const count = (...s: TeamMemberStatus[]) => lineup.filter((m) => s.includes(m.status)).length;
  const teamStepIds = lineup.flatMap((m) => m.stepIds);
  const doneSteps = steps.filter((s) => teamStepIds.includes(s.id) && s.status === 'done').length;
  const summary =
    teamStatus === 'not_started'
      ? 'Ready to start'
      : [
          count('running', 'merging') && `${count('running', 'merging')} working`,
          count('merged') && `${count('merged')} merged`,
          count('waiting') && `${count('waiting')} waiting`,
          count('failed', 'blocked') && `${count('failed', 'blocked')} need attention`,
        ]
          .filter(Boolean)
          .join(' · ');

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-3">
      <div className="flex-shrink-0 rounded-lg border border-gray-200 bg-white shadow-sm p-3 space-y-2.5">
        <div className="flex flex-wrap items-center gap-3">
          <TeamFaces personas={personas} />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-gray-900 flex items-center gap-1.5">
              <Users className="w-4 h-4 text-gray-500" />
              Coding team
            </div>
            <div className="text-xs text-gray-500">
              {TEAM_LEAD_PERSONA.name} (lead) + {lineup.length} engineers · {summary}
            </div>
          </div>
          {canStart && (
            <Button size="sm" onClick={onStart} disabled={starting}>
              {starting ? (
                <Loader2 className="animate-spin" />
              ) : teamStatus === 'not_started' ? (
                <Play />
              ) : (
                <RotateCcw />
              )}
              {teamStatus === 'not_started' ? 'Start the team' : 'Resume the team'}
            </Button>
          )}
        </div>
        <div>
          <div className="flex justify-between text-xs text-gray-500 mb-1">
            <span>
              {doneSteps} of {teamStepIds.length} steps done
            </span>
            {branch && (
              <span className="break-all">
                merging into <code className="text-gray-700">{branch}</code>
              </span>
            )}
          </div>
          <div className="h-1.5 rounded-full bg-gray-100 overflow-hidden">
            <div
              className="h-full bg-green-500 transition-all"
              style={{
                width: `${teamStepIds.length ? (doneSteps / teamStepIds.length) * 100 : 0}%`,
              }}
            />
          </div>
        </div>
        {teamFinished && (
          <div className={`text-xs ${teamStatus === 'done' ? 'text-green-700' : 'text-amber-700'}`}>
            {teamStatus === 'done'
              ? `Everyone's work is merged — review the diff, or ask ${TEAM_LEAD_PERSONA.name} for changes.`
              : `Not everything merged — resume the team to retry, or ask ${TEAM_LEAD_PERSONA.name} to finish it.`}
          </div>
        )}

        <div role="tablist" className="flex flex-wrap gap-1.5 pt-0.5">
          {lineup.map((m, i) => (
            <button
              key={m.id}
              role="tab"
              type="button"
              aria-selected={selected === m.id}
              onClick={() => setPicked(m.id)}
              className={`inline-flex items-center gap-1.5 rounded-full border pl-1 pr-2.5 py-1 text-sm transition-colors ${
                selected === m.id
                  ? 'border-blue-300 bg-blue-50 text-blue-800'
                  : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50'
              }`}
              title={`${personas[i].name} · ${m.title} — ${STATUS_META[m.status].label}`}
            >
              <AgentAvatar agent={personas[i]} size="xs" />
              <span className="font-medium">{personas[i].name}</span>
              <StatusIcon status={m.status} className="w-3.5 h-3.5 text-gray-500" />
            </button>
          ))}
          <button
            role="tab"
            type="button"
            aria-selected={selected === LEAD_TAB}
            onClick={() => setPicked(LEAD_TAB)}
            className={`inline-flex items-center gap-1.5 rounded-full border pl-1 pr-2.5 py-1 text-sm transition-colors ${
              selected === LEAD_TAB
                ? 'border-blue-300 bg-blue-50 text-blue-800'
                : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50'
            }`}
          >
            <AgentAvatar agent={TEAM_LEAD_PERSONA} size="xs" />
            <span className="font-medium">{TEAM_LEAD_PERSONA.name}</span>
            <span className="text-xs text-gray-500">lead</span>
          </button>
        </div>
      </div>

      {member ? (
        <div className="flex flex-col flex-1 min-h-0 gap-3">
          <div className="flex-shrink-0 space-y-2">
            <CodingPlanChecklist
              title={`${personas[selectedIndex].name}'s steps · ${member.title}`}
              steps={member.stepIds.map(
                (id) =>
                  steps.find((s) => s.id === id) ?? {
                    id,
                    title: id,
                    status: 'pending' as const,
                  },
              )}
            />
            <OwnedPaths paths={member.ownedPaths} />
            {member.note &&
              (member.status === 'failed' || member.status === 'blocked' || member.status === 'waiting') && (
                <div className={`text-xs ${member.status === 'waiting' ? 'text-gray-500' : 'text-red-600'}`}>
                  {member.note}
                </div>
              )}
          </div>
          <MemberLog
            key={member.id}
            member={member}
            persona={personas[selectedIndex]}
            lineup={lineup}
            entries={entriesFor(member)}
            runningTool={runningTools[member.id] ?? null}
          />
        </div>
      ) : (
        leadChat
      )}
    </div>
  );
}
