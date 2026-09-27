'use client';

import { useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Circle,
  CircleDot,
  Clock,
  FolderLock,
  GitMerge,
  Loader2,
  Play,
  RotateCcw,
  Users,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { CodingPlanStep, CodingTeamMember, PlanStepSummary, PlanWorkstream, TeamMemberStatus, TranscriptEntry } from '@/lib/dev-sessions/types';
import { TEAM_LEAD_PERSONA, teamMemberPersona, type AgentPersona, type TeamPersona } from '@/lib/dev-sessions/agents';
import { Pill } from './PageShell';

function Avatar({ persona, gradient, size = 'md' }: { persona: AgentPersona; gradient: string; size?: 'sm' | 'md' }) {
  const dims = size === 'sm' ? 'w-6 h-6 text-[10px]' : 'w-9 h-9 text-xs';
  return (
    <div
      className={`${dims} flex-shrink-0 rounded-full bg-gradient-to-br ${gradient} text-white font-semibold flex items-center justify-center ring-2 ring-white`}
      title={persona.fullName}
    >
      {persona.initials}
    </div>
  );
}

const LEAD_GRADIENT = 'from-blue-500 to-purple-500';

/** Jack plus the engineers' stacked avatars — the "this is a team" signal used on both tabs. */
function TeamFaces({ personas }: { personas: TeamPersona[] }) {
  return (
    <div className="flex items-center">
      <Avatar persona={TEAM_LEAD_PERSONA} gradient={LEAD_GRADIENT} />
      <div className="flex -space-x-2 ml-1">
        {personas.map((p) => (
          <Avatar key={p.name} persona={p} gradient={p.color.avatar} size="sm" />
        ))}
      </div>
    </div>
  );
}

function OwnedPaths({ paths }: { paths: string[] }) {
  const [open, setOpen] = useState(false);
  const shown = open ? paths : paths.slice(0, 3);
  return (
    <div className="flex flex-wrap items-center gap-1">
      <FolderLock className="w-3.5 h-3.5 text-gray-400" aria-label="Owns" />
      {shown.map((p) => (
        <code key={p} className="text-[11px] bg-gray-100 text-gray-700 rounded px-1.5 py-0.5">
          {p}
        </code>
      ))}
      {paths.length > 3 && (
        <button type="button" className="text-[11px] text-blue-600 hover:underline" onClick={() => setOpen((v) => !v)}>
          {open ? 'less' : `+${paths.length - 3} more`}
        </button>
      )}
    </div>
  );
}

function waitsFor(ws: PlanWorkstream, all: PlanWorkstream[]): string | null {
  if (ws.dependsOn.length === 0) return null;
  return ws.dependsOn
    .map((id) => {
      const i = all.findIndex((w) => w.id === id);
      return i >= 0 ? teamMemberPersona(i, all[i].title).name : id;
    })
    .join(' & ');
}

/** Plan tab: who will build what, in parallel, once the plan is approved. */
export function TeamPlanPanel({ workstreams, steps }: { workstreams: PlanWorkstream[]; steps: PlanStepSummary[] }) {
  const personas = workstreams.map((w, i) => teamMemberPersona(i, w.title));
  const parallelAtStart = workstreams.filter((w) => w.dependsOn.length === 0).length;
  const stepTitle = (id: string) => steps.find((s) => s.id === id)?.title ?? id;

  return (
    <div className="rounded-lg border border-indigo-200 bg-indigo-50/50 p-3 space-y-3">
      <div className="flex items-center gap-3">
        <TeamFaces personas={personas} />
        <div className="min-w-0">
          <div className="text-sm font-semibold text-gray-900 flex items-center gap-1.5">
            <Users className="w-4 h-4 text-indigo-600" />
            Coded by a team of {workstreams.length + 1} agents
          </div>
          <div className="text-xs text-gray-600">
            {TEAM_LEAD_PERSONA.name} leads; {workstreams.length} engineers each build one workstream in their own checkout —{' '}
            {parallelAtStart} start at once, and each owns its own files so their work merges cleanly.
          </div>
        </div>
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-2">
        {workstreams.map((ws, i) => {
          const persona = personas[i];
          const after = waitsFor(ws, workstreams);
          return (
            <div key={ws.id} className={`rounded-md border-l-4 ${persona.color.ring} border border-gray-200 bg-white p-2.5 space-y-2`}>
              <div className="flex items-center gap-2">
                <Avatar persona={persona} gradient={persona.color.avatar} size="sm" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-gray-900 truncate">
                    {persona.name} <span className="font-normal text-gray-500">· {ws.title}</span>
                  </div>
                </div>
                <Pill tone={after ? 'amber' : 'green'}>{after ? `after ${after}` : 'starts right away'}</Pill>
              </div>
              <ol className="text-xs text-gray-700 space-y-0.5 list-decimal list-inside">
                {ws.stepIds.map((id) => (
                  <li key={id}>{stepTitle(id)}</li>
                ))}
              </ol>
              <OwnedPaths paths={ws.ownedPaths} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

const STATUS_META: Record<TeamMemberStatus, { label: string; tone: 'neutral' | 'blue' | 'green' | 'red' | 'amber' }> = {
  waiting: { label: 'Waiting', tone: 'neutral' },
  running: { label: 'Working', tone: 'blue' },
  merging: { label: 'Merging', tone: 'blue' },
  merged: { label: 'Merged', tone: 'green' },
  failed: { label: 'Needs attention', tone: 'red' },
  blocked: { label: 'Blocked', tone: 'amber' },
};

function StatusIcon({ status }: { status: TeamMemberStatus }) {
  if (status === 'running') return <Loader2 className="w-3 h-3 animate-spin" />;
  if (status === 'merging') return <GitMerge className="w-3 h-3" />;
  if (status === 'merged') return <CheckCircle2 className="w-3 h-3" />;
  if (status === 'failed' || status === 'blocked') return <AlertTriangle className="w-3 h-3" />;
  return <Clock className="w-3 h-3" />;
}

function stripToolPrefix(name: string | undefined): string {
  return (name ?? '').replace(/^mcp__[^_]+(-[^_]+)?__/, '');
}

function describeTool(entry: TranscriptEntry): string {
  const input = (entry.toolInput ?? {}) as Record<string, unknown>;
  const detail = ['path', 'message', 'command', 'query'].map((k) => input[k]).find((v) => typeof v === 'string') as string | undefined;
  return `${stripToolPrefix(entry.toolName)}${detail ? ` · ${detail}` : ''}`;
}

function MemberLog({ entries }: { entries: TranscriptEntry[] }) {
  const visible = entries.filter((e) => e.role !== 'tool_result' || e.isError).slice(-40);
  if (visible.length === 0) return <div className="text-xs text-gray-400 px-1">Nothing yet.</div>;
  return (
    <ul className="space-y-1 max-h-64 overflow-y-auto custom-scrollbar text-xs">
      {visible.map((e) => (
        <li key={e.id} className={e.isError ? 'text-red-600' : e.role === 'tool_call' ? 'font-mono text-gray-500 truncate' : 'text-gray-700 whitespace-pre-wrap'}>
          {e.role === 'tool_call' ? `→ ${describeTool(e)}` : e.role === 'tool_result' ? `✗ ${String(e.toolResult ?? '').slice(0, 300)}` : e.text}
        </li>
      ))}
    </ul>
  );
}

function MemberLane({
  member,
  index,
  members,
  steps,
  entries,
  runningTool,
}: {
  member: CodingTeamMember;
  index: number;
  members: CodingTeamMember[];
  steps: CodingPlanStep[];
  entries: TranscriptEntry[];
  runningTool: string | null;
}) {
  const [showLog, setShowLog] = useState(false);
  const persona = teamMemberPersona(index, member.title);
  const meta = STATUS_META[member.status];
  const mySteps = member.stepIds.map((id) => steps.find((s) => s.id === id) ?? { id, title: id, status: 'pending' as const });
  const done = mySteps.filter((s) => s.status === 'done').length;
  const lastCall = [...entries].reverse().find((e) => e.role === 'tool_call');
  const after = member.status === 'waiting' ? waitsFor(member, members) : null;
  const active = member.status === 'running' || member.status === 'merging';

  return (
    <div className={`rounded-lg border-l-4 ${persona.color.ring} border border-gray-200 bg-white p-3 space-y-2 ${active ? 'shadow-sm' : ''}`}>
      <div className="flex items-center gap-2">
        <div className="relative">
          <Avatar persona={persona} gradient={persona.color.avatar} />
          {active && <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-green-500 ring-2 ring-white animate-pulse" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-gray-900" title={persona.fullName}>
            {persona.name}
          </div>
          <div className="text-xs text-gray-500 truncate">{member.title}</div>
        </div>
        <Pill tone={meta.tone}>
          <StatusIcon status={member.status} />
          {meta.label}
        </Pill>
      </div>

      <div className={`rounded px-2 py-1 text-xs ${persona.color.soft} ${persona.color.text} truncate`}>
        {member.status === 'running'
          ? runningTool
            ? `Running ${stripToolPrefix(runningTool)}…`
            : lastCall
              ? `Last: ${describeTool(lastCall)}`
              : 'Getting started…'
          : member.status === 'merging'
            ? `Merging ${member.branch} into the session branch…`
            : member.status === 'merged'
              ? 'Work merged into the session branch.'
              : after
                ? `Starts once ${after} ${after.includes('&') ? 'have' : 'has'} merged.`
                : member.note ?? 'Queued.'}
      </div>
      {member.note && (member.status === 'failed' || member.status === 'blocked') && (
        <div className="text-xs text-red-600">{member.note}</div>
      )}

      <div>
        <div className="flex items-center justify-between text-[11px] text-gray-500 mb-1">
          <span>
            {done} of {mySteps.length} steps
          </span>
        </div>
        <div className="h-1 rounded-full bg-gray-100 overflow-hidden mb-1.5">
          <div className="h-full bg-green-500 transition-all" style={{ width: `${mySteps.length ? (done / mySteps.length) * 100 : 0}%` }} />
        </div>
        <ul className="space-y-0.5">
          {mySteps.map((s) => (
            <li key={s.id} className={`flex items-start gap-1.5 text-xs ${s.status === 'done' ? 'text-gray-500' : s.status === 'in_progress' ? 'text-blue-700 font-medium' : 'text-gray-700'}`}>
              {s.status === 'done' ? (
                <CheckCircle2 className="w-3.5 h-3.5 mt-px text-green-600 flex-shrink-0" />
              ) : s.status === 'in_progress' ? (
                <CircleDot className="w-3.5 h-3.5 mt-px text-blue-600 flex-shrink-0" />
              ) : (
                <Circle className="w-3.5 h-3.5 mt-px text-gray-300 flex-shrink-0" />
              )}
              {s.title}
            </li>
          ))}
        </ul>
      </div>

      <OwnedPaths paths={member.ownedPaths} />

      <button type="button" className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-800" onClick={() => setShowLog((v) => !v)}>
        <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showLog ? 'rotate-180' : ''}`} />
        {showLog ? 'Hide' : 'Show'} {persona.name}&apos;s log ({entries.length})
      </button>
      {showLog && <MemberLog entries={entries} />}
    </div>
  );
}

export interface CodingTeamBoardProps {
  /** Before the team has started, the lineup comes from the approved plan. */
  workstreams: PlanWorkstream[];
  members: CodingTeamMember[] | null;
  teamStatus: 'not_started' | 'running' | 'done' | 'needs_attention' | 'interrupted';
  steps: CodingPlanStep[];
  branch: string | null;
  entriesFor: (member: CodingTeamMember) => TranscriptEntry[];
  runningTools: Record<string, string | null>;
  canStart: boolean;
  starting: boolean;
  onStart: () => void;
}

/** Coding tab: the team at work — one lane per engineer, with the lead's role spelled out. */
export function CodingTeamBoard({ workstreams, members, teamStatus, steps, branch, entriesFor, runningTools, canStart, starting, onStart }: CodingTeamBoardProps) {
  const lineup: CodingTeamMember[] =
    members ??
    workstreams.map((ws) => ({ ...ws, branch: '', status: 'waiting', note: null, startedAt: null, finishedAt: null, transcript: [] }));
  const personas = lineup.map((m, i) => teamMemberPersona(i, m.title));
  const count = (s: TeamMemberStatus) => lineup.filter((m) => m.status === s).length;
  const allSteps = lineup.flatMap((m) => m.stepIds);
  const doneSteps = steps.filter((s) => allSteps.includes(s.id) && s.status === 'done').length;

  const summary =
    teamStatus === 'not_started'
      ? 'Ready to start'
      : [
          count('running') + count('merging') ? `${count('running') + count('merging')} working` : null,
          count('merged') ? `${count('merged')} merged` : null,
          count('waiting') ? `${count('waiting')} waiting` : null,
          count('failed') + count('blocked') ? `${count('failed') + count('blocked')} need attention` : null,
        ]
          .filter(Boolean)
          .join(' · ');

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-lg border border-indigo-200 bg-gradient-to-r from-indigo-50 via-white to-purple-50 p-3">
        <div className="flex flex-wrap items-center gap-3">
          <TeamFaces personas={personas} />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-gray-900 flex items-center gap-1.5">
              <Users className="w-4 h-4 text-indigo-600" />
              Coding team · {lineup.length} engineers + {TEAM_LEAD_PERSONA.name} (lead)
            </div>
            <div className="text-xs text-gray-600">{summary}</div>
          </div>
          {canStart && (
            <Button size="sm" variant="blue" onClick={onStart} disabled={starting}>
              {starting ? <Loader2 className="animate-spin" /> : teamStatus === 'not_started' ? <Play /> : <RotateCcw />}
              {teamStatus === 'not_started' ? 'Start the team' : 'Resume the team'}
            </Button>
          )}
        </div>
        <div className="mt-2 h-1.5 rounded-full bg-white/80 overflow-hidden">
          <div className="h-full bg-green-500 transition-all" style={{ width: `${allSteps.length ? (doneSteps / allSteps.length) * 100 : 0}%` }} />
        </div>
        <div className="mt-1.5 text-[11px] text-gray-500">
          {doneSteps} of {allSteps.length} steps done. Each engineer works in its own checkout of the repo and can only write the
          files it owns; {TEAM_LEAD_PERSONA.name} merges each finished branch into{' '}
          {branch ? <code className="text-gray-700">{branch}</code> : 'the session branch'} and takes your follow-ups once
          everyone is done.
        </div>
      </div>

      <div className="grid grid-cols-1 2xl:grid-cols-2 gap-3">
        {lineup.map((member, i) => (
          <MemberLane
            key={member.id}
            member={member}
            index={i}
            members={lineup}
            steps={steps}
            entries={entriesFor(member)}
            runningTool={runningTools[member.id] ?? null}
          />
        ))}
      </div>
    </div>
  );
}
