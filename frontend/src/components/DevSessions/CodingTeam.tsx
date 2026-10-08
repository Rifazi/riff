'use client';

import React from 'react';
import { FolderLock } from 'lucide-react';
import type {
  CodingPlanStep,
  CodingTeamMember,
  CodingTeamState,
  TranscriptEntry,
  Workstream,
} from '@/lib/dev-sessions/types';
import { TEAM_LEAD_PERSONA, teamMemberPersona } from '@/lib/dev-sessions/agents';
import { CodingPlanChecklist } from './CodingPlanChecklist';
import { EarlierRounds, PathChips, TeamPanel, pastTeamStatus, type TeamStatus } from './AgentTeam';

// Jack's coding team on the shared team board (AgentTeam.tsx): engineers
// own paths, build checklist steps and merge into the session branch.

function nameOf(id: string, all: Workstream[]): string {
  const i = all.findIndex((w) => w.id === id);
  return i >= 0 ? teamMemberPersona(i, all[i].title).name : id;
}

function waitsFor(ws: Workstream, all: Workstream[]): string | null {
  return ws.dependsOn.length ? ws.dependsOn.map((id) => nameOf(id, all)).join(' & ') : null;
}

const KIND_NOTE: Record<CodingTeamState['kind'], string> = { plan: '', 'qa-fix': ', QA fixes', 'follow-up': ', follow-ups' };

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
  leadChat: React.ReactNode;
  leadActive: boolean;
  past?: boolean;
}

/** Coding tab in team mode. */
export function CodingTeamPanel({ round, kind, members, steps, branch, teamStatus, past, ...rest }: CodingTeamPanelProps) {
  const lead = TEAM_LEAD_PERSONA.name;
  const teamStepIds = members.flatMap((m) => m.stepIds);
  const doneSteps = steps.filter((s) => teamStepIds.includes(s.id) && s.status === 'done').length;
  const finishedNote = past
    ? teamStatus === 'done'
      ? { ok: true, text: "An earlier round — everyone's work was merged." }
      : { ok: false, text: 'An earlier round — not everything merged before the next one started.' }
    : teamStatus === 'done'
      ? { ok: true, text: `Everyone's work is merged — review the diff, or ask ${lead} for changes.` }
      : { ok: false, text: `Not everything merged — resume the team to retry, or ask ${lead} to finish it.` };

  return (
    <TeamPanel
      {...rest}
      label="Coding team"
      round={round}
      roundNote={KIND_NOTE[kind]}
      lead={TEAM_LEAD_PERSONA}
      memberNoun="engineers"
      personaFor={teamMemberPersona}
      members={members}
      teamStatus={teamStatus}
      past={past}
      progress={{
        done: doneSteps,
        total: teamStepIds.length,
        label: 'steps done',
        aside: branch && (
          <span className="break-all">
            merging into <code className="text-foreground">{branch}</code>
          </span>
        ),
      }}
      finishedNote={finishedNote}
      retryLabel="Retry this engineer"
      renderDetails={(member, persona) => (
        <>
          <CodingPlanChecklist
            title={`${persona.name}'s steps · ${member.title}`}
            steps={member.stepIds.map(
              (id) => steps.find((s) => s.id === id) ?? { id, title: id, status: 'pending' as const },
            )}
          />
          <PathChips icon={FolderLock} label="Owns" paths={member.ownedPaths} />
        </>
      )}
      emptyHint={(member, persona) => {
        const after = waitsFor(member, members);
        return member.status === 'waiting' && after
          ? `${persona.name} starts once ${after} ${after.includes('&') ? 'have' : 'has'} merged.`
          : `${persona.name} hasn't started yet.`;
      }}
      readOnlyNote={(member, persona) =>
        member.status === 'merging'
          ? `Merging ${member.branch} into the session branch…`
          : `${persona.name}'s full log — read only. ${lead} takes follow-ups once the team is done.`
      }
    />
  );
}

const KIND_LABEL: Record<CodingTeamState['kind'], string> = {
  plan: 'The plan',
  'qa-fix': 'QA fixes',
  'follow-up': 'Follow-ups',
};

/**
 * Coding team rounds that are over (SessionRecord.codingTeamHistory),
 * collapsed so the Coding tab shows only who's working now.
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
  return (
    <EarlierRounds
      rounds={rounds}
      kindLabel={(team) => KIND_LABEL[team.kind]}
      doneLabel="Merged"
      memberNoun="engineers"
      personaFor={teamMemberPersona}
      renderRound={(team) => (
        <CodingTeamPanel
          round={team.round}
          kind={team.kind}
          members={team.members}
          teamStatus={pastTeamStatus(team.status)}
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
    />
  );
}
