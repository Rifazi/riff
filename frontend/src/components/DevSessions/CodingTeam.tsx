'use client';

import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
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
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import type {
  CodingPlanStep,
  CodingTeamMember,
  CodingTeamState,
  TeamMemberStatus,
  TranscriptEntry,
  Workstream,
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

/** Jack followed by the engineers — the one "this is a team" visual. */
function TeamFaces({ personas }: { personas: TeamPersona[] }) {
  return (
    <div className="flex items-center flex-shrink-0">
      <AgentAvatar agent={TEAM_LEAD_PERSONA} />
      <div className="flex -space-x-1.5 ml-1">
        {personas.map((p) => (
          <div key={p.name} className="rounded-full ring-2 ring-card">
            <AgentAvatar agent={p} size="sm" />
          </div>
        ))}
      </div>
    </div>
  );
}

function OwnedPaths({ paths }: { paths: string[] }) {
  return (
    <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
      <FolderLock className="w-3.5 h-3.5 flex-shrink-0" />
      <span>Owns</span>
      {paths.map((p) => (
        <code key={p} className="text-[11px] bg-muted text-foreground rounded px-1.5 py-0.5 break-all">
          {p}
        </code>
      ))}
    </div>
  );
}

function nameOf(id: string, all: Workstream[]): string {
  const i = all.findIndex((w) => w.id === id);
  return i >= 0 ? teamMemberPersona(i, all[i].title).name : id;
}

function waitsFor(ws: Workstream, all: Workstream[]): string | null {
  return ws.dependsOn.length ? ws.dependsOn.map((id) => nameOf(id, all)).join(' & ') : null;
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
  /** The lead's split: what this round builds, and who builds it. */
  round: number;
  kind: CodingTeamState['kind'];
  members: CodingTeamMember[];
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
  /** The lead is mid-turn — e.g. still explaining the split it just made. */
  leadActive: boolean;
  /** An earlier round, read only: no lead tab (Jack's chat is the current one). */
  past?: boolean;
}

const LEAD_TAB = '__lead__';

/**
 * Coding tab in team mode: a summary card, one tab per engineer plus the
 * lead, and the selected member's full log in the same chat UI used for
 * every other agent.
 */
export function CodingTeamPanel(props: CodingTeamPanelProps) {
  const {
    round,
    kind,
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
    leadActive,
    past,
  } = props;
  const lineup = members;
  // Keyed on the titles so each persona keeps its identity across refetches:
  // the member logs' ChatPane rows are memoized on it.
  const titlesKey = JSON.stringify(lineup.map((m) => m.title));
  const personas = useMemo(
    () => (JSON.parse(titlesKey) as string[]).map((title, i) => teamMemberPersona(i, title)),
    [titlesKey]
  );

  const [picked, setPicked] = useState<string | null>(null);
  // An earlier round is opened to read its engineers' logs.
  const defaultTab = past
    ? (lineup[0]?.id ?? LEAD_TAB)
    : teamFinished || leadActive
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
      <Card className="flex-shrink-0 p-3 space-y-2.5">
        <div className="flex flex-wrap items-center gap-3">
          <TeamFaces personas={personas} />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-foreground flex items-center gap-1.5">
              <Users className="w-4 h-4 text-muted-foreground" />
              Coding team
              {round > 1 && (
                <span className="font-normal text-muted-foreground">
                  · round {round}
                  {kind === 'qa-fix' ? ', QA fixes' : kind === 'follow-up' ? ', follow-ups' : ''}
                </span>
              )}
            </div>
            <div className="text-xs text-muted-foreground">
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
          <div className="flex justify-between text-xs text-muted-foreground mb-1">
            <span>
              {doneSteps} of {teamStepIds.length} steps done
            </span>
            {branch && (
              <span className="break-all">
                merging into <code className="text-foreground">{branch}</code>
              </span>
            )}
          </div>
          <div className="h-1.5 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full bg-success transition-all"
              style={{
                width: `${teamStepIds.length ? (doneSteps / teamStepIds.length) * 100 : 0}%`,
              }}
            />
          </div>
        </div>
        {teamFinished && (
          <div className={`text-xs ${teamStatus === 'done' ? 'text-success' : 'text-warning'}`}>
            {past
              ? teamStatus === 'done'
                ? "An earlier round — everyone's work was merged."
                : 'An earlier round — not everything merged before the next one started.'
              : teamStatus === 'done'
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
                  ? 'border-primary/40 bg-primary/10 text-primary'
                  : 'border-border bg-card text-card-foreground hover:bg-muted'
              }`}
              title={`${personas[i].name} · ${m.title} — ${STATUS_META[m.status].label}`}
            >
              <AgentAvatar agent={personas[i]} size="xs" />
              <span className="font-medium">{personas[i].name}</span>
              <StatusIcon status={m.status} className="w-3.5 h-3.5 text-muted-foreground" />
            </button>
          ))}
          {!past && (
            <button
              role="tab"
              type="button"
              aria-selected={selected === LEAD_TAB}
              onClick={() => setPicked(LEAD_TAB)}
              className={`inline-flex items-center gap-1.5 rounded-full border pl-1 pr-2.5 py-1 text-sm transition-colors ${
                selected === LEAD_TAB
                  ? 'border-primary/40 bg-primary/10 text-primary'
                  : 'border-border bg-card text-card-foreground hover:bg-muted'
              }`}
            >
              <AgentAvatar agent={TEAM_LEAD_PERSONA} size="xs" />
              <span className="font-medium">{TEAM_LEAD_PERSONA.name}</span>
              <span className="text-xs text-muted-foreground">lead</span>
            </button>
          )}
        </div>
      </Card>

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
                <div className="space-y-1.5">
                  <div
                    className={`text-xs ${member.status === 'waiting' ? 'text-muted-foreground' : 'text-destructive'}`}
                  >
                    {member.note}
                  </div>
                  {member.status === 'failed' && canStart && (
                    <Button size="sm" variant="outline" onClick={onStart} disabled={starting}>
                      {starting ? <Loader2 className="animate-spin" /> : <RotateCcw />}
                      Retry this engineer
                    </Button>
                  )}
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

// ---------------------------------------------------------------- earlier rounds

const KIND_LABEL: Record<CodingTeamState['kind'], string> = {
  plan: 'The plan',
  'qa-fix': 'QA fixes',
  'follow-up': 'Follow-ups',
};

const ROUND_STATUS: Record<
  CodingTeamState['status'],
  { label: string; variant: NonNullable<BadgeProps['variant']> }
> = {
  assigned: { label: 'Not started', variant: 'secondary' },
  running: { label: 'Interrupted', variant: 'warning' },
  done: { label: 'Merged', variant: 'success' },
  needs_attention: { label: 'Needs attention', variant: 'warning' },
  interrupted: { label: 'Interrupted', variant: 'warning' },
};

function roundWhen(iso: string): string | null {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? null
    : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/**
 * Team rounds that are over (SessionRecord.codingTeamHistory), collapsed so
 * the Coding tab shows only who's working now. Each opens its engineers'
 * logs, read only.
 */
export function EarlierTeamRounds({
  rounds,
  steps,
  branch,
}: {
  rounds: CodingTeamState[];
  steps: CodingPlanStep[];
  branch: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [viewing, setViewing] = useState<CodingTeamState | null>(null);
  if (rounds.length === 0) return null;
  return (
    <Card className="flex-shrink-0 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted transition-colors"
      >
        <ChevronDown
          className={`w-4 h-4 flex-shrink-0 text-muted-foreground transition-transform ${open ? '' : '-rotate-90'}`}
        />
        <Users className="w-4 h-4 flex-shrink-0 text-muted-foreground" />
        <span className="font-medium text-foreground">Earlier team rounds</span>
        <span className="text-xs text-muted-foreground">{rounds.length}</span>
      </button>
      {open && (
        <div className="border-t border-border p-1.5 space-y-1">
          {[...rounds].reverse().map((team) => {
            const status = ROUND_STATUS[team.status];
            const when = roundWhen(team.startedAt);
            return (
              <button
                key={team.round}
                type="button"
                onClick={() => setViewing(team)}
                className="w-full flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md px-2.5 py-2 text-left hover:bg-muted transition-colors"
                title={`Open round ${team.round}'s logs`}
              >
                <div className="flex -space-x-1.5 flex-shrink-0">
                  {team.members.map((m, i) => (
                    <div key={m.id} className="rounded-full ring-2 ring-card">
                      <AgentAvatar agent={teamMemberPersona(i, m.title)} size="xs" />
                    </div>
                  ))}
                </div>
                <span className="text-sm font-semibold text-foreground whitespace-nowrap">Round {team.round}</span>
                <span className="text-sm text-foreground whitespace-nowrap">{KIND_LABEL[team.kind]}</span>
                <span className="text-xs text-muted-foreground whitespace-nowrap">
                  {team.members.length} engineers{when ? ` · ${when}` : ''}
                </span>
                <Badge variant={status.variant} className="ml-auto">
                  {status.label}
                </Badge>
              </button>
            );
          })}
        </div>
      )}
      <Dialog open={viewing !== null} onOpenChange={(o) => !o && setViewing(null)}>
        <DialogContent className="max-w-5xl w-[95vw] h-[88vh] p-4 gap-0 flex flex-col overflow-hidden">
          <DialogTitle className="sr-only">Team round {viewing?.round}</DialogTitle>
          {viewing && (
            <CodingTeamPanel
              key={viewing.round}
              round={viewing.round}
              kind={viewing.kind}
              members={viewing.members}
              teamStatus={
                viewing.status === 'assigned'
                  ? 'not_started'
                  : viewing.status === 'running'
                    ? 'interrupted'
                    : viewing.status
              }
              teamFinished
              steps={steps}
              branch={branch}
              entriesFor={(m) => m.transcript}
              runningTools={{}}
              canStart={false}
              starting={false}
              onStart={() => {}}
              leadChat={null}
              leadActive={false}
              past
            />
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
