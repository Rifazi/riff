'use client';

import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Clock,
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
import type { QaReviewerStatus, TeamMemberStatus, TranscriptEntry } from '@/lib/dev-sessions/types';
import type { AgentPersona, TeamPersona } from '@/lib/dev-sessions/agents';
import { AgentAvatar, ChatPane } from './ChatPane';

// The team board both teams use: Jack's coding team (CodingTeam.tsx) and
// Tess's QA team (QaTeam.tsx). It knows members, statuses, logs and the
// lead; what a member works on is the caller's renderDetails.

export type MemberStatus = TeamMemberStatus | QaReviewerStatus;

const STATUS_META: Record<MemberStatus, { label: string; variant: NonNullable<BadgeProps['variant']> }> = {
  waiting: { label: 'Waiting', variant: 'secondary' },
  running: { label: 'Working', variant: 'info' },
  merging: { label: 'Merging', variant: 'info' },
  merged: { label: 'Merged', variant: 'success' },
  done: { label: 'Done', variant: 'success' },
  failed: { label: 'Needs attention', variant: 'destructive' },
  blocked: { label: 'Blocked', variant: 'warning' },
};

export function StatusIcon({ status, className = 'w-3 h-3' }: { status: MemberStatus; className?: string }) {
  if (status === 'running') return <Loader2 className={`${className} animate-spin`} />;
  if (status === 'merging') return <GitMerge className={className} />;
  if (status === 'merged' || status === 'done') return <CheckCircle2 className={className} />;
  if (status === 'failed' || status === 'blocked') return <AlertTriangle className={className} />;
  return <Clock className={className} />;
}

function StatusPill({ status }: { status: MemberStatus }) {
  const meta = STATUS_META[status];
  return (
    <Badge variant={meta.variant} className="gap-1">
      <StatusIcon status={status} />
      {meta.label}
    </Badge>
  );
}

/** The lead followed by the team — the one "this is a team" visual. */
function TeamFaces({ lead, personas }: { lead: AgentPersona; personas: TeamPersona[] }) {
  return (
    <div className="flex items-center flex-shrink-0">
      <AgentAvatar agent={lead} />
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

/** A labelled row of repo paths: what an engineer owns, or where a reviewer looks. */
export function PathChips({ icon: Icon, label, paths }: { icon: React.ElementType; label: string; paths: string[] }) {
  if (paths.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
      <Icon className="w-3.5 h-3.5 flex-shrink-0" />
      <span>{label}</span>
      {paths.map((p) => (
        <code key={p} className="text-[11px] bg-muted text-foreground rounded px-1.5 py-0.5 break-all">
          {p}
        </code>
      ))}
    </div>
  );
}

export type TeamStatus = 'not_started' | 'running' | 'done' | 'needs_attention' | 'interrupted';

/** What the board needs of a member; each team's member type has more. */
export interface TeamMemberView {
  id: string;
  title: string;
  status: MemberStatus;
  note: string | null;
}

function MemberLog({
  persona,
  status,
  entries,
  runningTool,
  emptyHint,
  readOnlyNote,
}: {
  persona: TeamPersona;
  status: MemberStatus;
  entries: TranscriptEntry[];
  runningTool: string | null;
  emptyHint: string;
  readOnlyNote: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const active = status === 'running' || status === 'merging';

  const pane = (expandedView: boolean) => (
    <ChatPane
      readOnly
      entries={entries}
      disabled
      streaming={active}
      runningTool={runningTool}
      agent={persona}
      className={expandedView ? 'border-0 shadow-none rounded-none' : undefined}
      emptyHint={emptyHint}
      headerActions={
        <>
          <StatusPill status={status} />
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
      readOnlyNote={readOnlyNote}
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

export interface TeamPanelProps<M extends TeamMemberView> {
  /** "Coding team" / "QA team". */
  label: string;
  round: number;
  /** After the round number, e.g. ", QA fixes". */
  roundNote?: string;
  lead: AgentPersona;
  /** "engineers" / "reviewers". */
  memberNoun: string;
  personaFor: (index: number, title: string) => TeamPersona;
  members: M[];
  teamStatus: TeamStatus;
  teamFinished: boolean;
  progress: { done: number; total: number; label: string; aside?: React.ReactNode };
  /** Anything else the summary card shows (the QA team's checks). */
  extra?: React.ReactNode;
  /** Shown once the round is over. */
  finishedNote?: { text: string; ok: boolean } | null;
  /** What the selected member works on, above its log. */
  renderDetails: (member: M, persona: TeamPersona) => React.ReactNode;
  emptyHint: (member: M, persona: TeamPersona) => string;
  readOnlyNote: (member: M, persona: TeamPersona) => string;
  /** "Retry this engineer". */
  retryLabel: string;
  entriesFor: (member: M) => TranscriptEntry[];
  runningTools: Record<string, string | null>;
  canStart: boolean;
  starting: boolean;
  onStart: () => void;
  /** The lead's chat (the same ChatPane the single-agent tab uses). */
  leadChat: React.ReactNode;
  /** The lead is mid-turn — e.g. still explaining the split it just made. */
  leadActive: boolean;
  /** An earlier round, read only: no lead tab (the lead's chat is the current one). */
  past?: boolean;
}

const LEAD_TAB = '__lead__';

/**
 * A tab in team mode: a summary card, one tab per member plus the lead,
 * and the selected member's full log in the same chat UI used for every
 * other agent.
 */
export function TeamPanel<M extends TeamMemberView>(props: TeamPanelProps<M>) {
  const {
    label,
    round,
    roundNote,
    lead,
    memberNoun,
    personaFor,
    members: lineup,
    teamStatus,
    teamFinished,
    progress,
    extra,
    finishedNote,
    renderDetails,
    emptyHint,
    readOnlyNote,
    retryLabel,
    entriesFor,
    runningTools,
    canStart,
    starting,
    onStart,
    leadChat,
    leadActive,
    past,
  } = props;
  // Keyed on the titles so each persona keeps its identity across refetches:
  // the member logs' ChatPane rows are memoized on it.
  const titlesKey = JSON.stringify(lineup.map((m) => m.title));
  const personas = useMemo(
    () => (JSON.parse(titlesKey) as string[]).map((title, i) => personaFor(i, title)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [titlesKey]
  );

  const [picked, setPicked] = useState<string | null>(null);
  // An earlier round is opened to read its members' logs.
  const defaultTab = past
    ? (lineup[0]?.id ?? LEAD_TAB)
    : teamFinished || leadActive
      ? LEAD_TAB
      : ((lineup.find((m) => m.status === 'running') ?? lineup[0])?.id ?? LEAD_TAB);
  const selected = picked ?? defaultTab;
  const selectedIndex = lineup.findIndex((m) => m.id === selected);
  const member = selectedIndex >= 0 ? lineup[selectedIndex] : null;

  const count = (...s: MemberStatus[]) => lineup.filter((m) => s.includes(m.status)).length;
  const summary =
    teamStatus === 'not_started'
      ? 'Ready to start'
      : [
          count('running', 'merging') && `${count('running', 'merging')} working`,
          count('merged') && `${count('merged')} merged`,
          count('done') && `${count('done')} done`,
          count('waiting') && `${count('waiting')} waiting`,
          count('failed', 'blocked') && `${count('failed', 'blocked')} need attention`,
        ]
          .filter(Boolean)
          .join(' · ');

  const tabClass = (active: boolean) =>
    `inline-flex items-center gap-1.5 rounded-full border pl-1 pr-2.5 py-1 text-sm transition-colors ${
      active ? 'border-primary/40 bg-primary/10 text-primary' : 'border-border bg-card text-card-foreground hover:bg-muted'
    }`;

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-3">
      <Card className="flex-shrink-0 p-3 space-y-2.5">
        <div className="flex flex-wrap items-center gap-3">
          <TeamFaces lead={lead} personas={personas} />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-foreground flex items-center gap-1.5">
              <Users className="w-4 h-4 text-muted-foreground" />
              {label}
              {round > 1 && (
                <span className="font-normal text-muted-foreground">
                  · round {round}
                  {roundNote}
                </span>
              )}
            </div>
            <div className="text-xs text-muted-foreground">
              {lead.name} (lead) + {lineup.length} {memberNoun} · {summary}
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
              {progress.done} of {progress.total} {progress.label}
            </span>
            {progress.aside}
          </div>
          <div className="h-1.5 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full bg-success transition-all"
              style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }}
            />
          </div>
        </div>
        {extra}
        {teamFinished && finishedNote && (
          <div className={`text-xs ${finishedNote.ok ? 'text-success' : 'text-warning'}`}>{finishedNote.text}</div>
        )}

        <div role="tablist" className="flex flex-wrap gap-1.5 pt-0.5">
          {lineup.map((m, i) => (
            <button
              key={m.id}
              role="tab"
              type="button"
              aria-selected={selected === m.id}
              onClick={() => setPicked(m.id)}
              className={tabClass(selected === m.id)}
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
              className={tabClass(selected === LEAD_TAB)}
            >
              <AgentAvatar agent={lead} size="xs" />
              <span className="font-medium">{lead.name}</span>
              <span className="text-xs text-muted-foreground">lead</span>
            </button>
          )}
        </div>
      </Card>

      {member ? (
        <div className="flex flex-col flex-1 min-h-0 gap-3">
          <div className="flex-shrink-0 space-y-2">
            {renderDetails(member, personas[selectedIndex])}
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
                      {retryLabel}
                    </Button>
                  )}
                </div>
              )}
          </div>
          <MemberLog
            key={member.id}
            persona={personas[selectedIndex]}
            status={member.status}
            entries={entriesFor(member)}
            runningTool={runningTools[member.id] ?? null}
            emptyHint={emptyHint(member, personas[selectedIndex])}
            readOnlyNote={readOnlyNote(member, personas[selectedIndex])}
          />
        </div>
      ) : (
        leadChat
      )}
    </div>
  );
}

// ---------------------------------------------------------------- earlier rounds

/** What the earlier-rounds list needs of a round; both teams' states fit. */
export interface TeamRoundView {
  round: number;
  status: 'assigned' | 'running' | 'done' | 'needs_attention' | 'interrupted';
  startedAt: string;
  members: { id: string; title: string }[];
}

function roundWhen(iso: string): string | null {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? null
    : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** A round's persisted status as the board shows it once the round is over. */
export function pastTeamStatus(status: TeamRoundView['status']): TeamStatus {
  return status === 'assigned' ? 'not_started' : status === 'running' ? 'interrupted' : status;
}

/**
 * Team rounds that are over, collapsed so the tab shows only who's working
 * now. Each opens its members' logs, read only, in renderRound.
 */
export function EarlierRounds<T extends TeamRoundView>({
  rounds,
  kindLabel,
  doneLabel,
  memberNoun,
  personaFor,
  renderRound,
}: {
  rounds: T[];
  kindLabel: (round: T) => string;
  /** The badge for a round where everyone finished: "Merged" / "Done". */
  doneLabel: string;
  memberNoun: string;
  personaFor: (index: number, title: string) => TeamPersona;
  renderRound: (round: T) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [viewing, setViewing] = useState<T | null>(null);
  if (rounds.length === 0) return null;
  const statusMeta: Record<TeamRoundView['status'], { label: string; variant: NonNullable<BadgeProps['variant']> }> = {
    assigned: { label: 'Not started', variant: 'secondary' },
    running: { label: 'Interrupted', variant: 'warning' },
    done: { label: doneLabel, variant: 'success' },
    needs_attention: { label: 'Needs attention', variant: 'warning' },
    interrupted: { label: 'Interrupted', variant: 'warning' },
  };
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
            const status = statusMeta[team.status];
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
                      <AgentAvatar agent={personaFor(i, m.title)} size="xs" />
                    </div>
                  ))}
                </div>
                <span className="text-sm font-semibold text-foreground whitespace-nowrap">Round {team.round}</span>
                <span className="text-sm text-foreground whitespace-nowrap">{kindLabel(team)}</span>
                <span className="text-xs text-muted-foreground whitespace-nowrap">
                  {team.members.length} {memberNoun}
                  {when ? ` · ${when}` : ''}
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
          {viewing && <React.Fragment key={viewing.round}>{renderRound(viewing)}</React.Fragment>}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
