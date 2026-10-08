'use client';

import React from 'react';
import { Loader2, ScanSearch } from 'lucide-react';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import type { QaTeamCheck, QaTeamMember, QaTeamState, TranscriptEntry } from '@/lib/dev-sessions/types';
import { QA_LEAD_PERSONA, qaReviewerPersona } from '@/lib/dev-sessions/agents';
import { CodingPlanChecklist, type ChecklistItem } from './CodingPlanChecklist';
import { EarlierRounds, PathChips, TeamPanel, pastTeamStatus, type TeamStatus } from './AgentTeam';

// Tess's QA team on the shared team board (AgentTeam.tsx): reviewers each
// check their own acceptance criteria, read only, while lint and the unit
// tests run alongside them; Tess writes the one report from their findings.

const CHECK_META: Record<QaTeamCheck['status'], { variant: NonNullable<BadgeProps['variant']>; label: string }> = {
  pending: { variant: 'secondary', label: 'waiting' },
  running: { variant: 'info', label: 'running' },
  pass: { variant: 'success', label: 'pass' },
  fail: { variant: 'destructive', label: 'fail' },
};

function ChecksRow({ checks }: { checks: QaTeamCheck[] }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      <span>Checks alongside the review:</span>
      {checks.map((c) => (
        <Badge key={c.command} variant={CHECK_META[c.status].variant} className="gap-1">
          {c.status === 'running' && <Loader2 className="w-3 h-3 animate-spin" />}
          {c.command === 'test' ? 'unit tests' : c.command}: {CHECK_META[c.status].label}
        </Badge>
      ))}
    </div>
  );
}

/** A reviewer's criteria as a checklist: met = done, not met = failed, unverified stays open. */
function criteriaItems(member: QaTeamMember): ChecklistItem[] {
  return member.criteria.map((criterion, i) => {
    const verdict = member.findings?.criteria.find((c) => c.criterion.trim() === criterion.trim());
    const status: ChecklistItem['status'] = verdict
      ? verdict.verdict === 'met'
        ? 'done'
        : verdict.verdict === 'not-met'
          ? 'failed'
          : 'pending'
      : member.status === 'running'
        ? 'in_progress'
        : 'pending';
    return { id: `${i}`, title: criterion, status, brief: verdict ? `${verdict.verdict}: ${verdict.note}` : undefined };
  });
}

function FindingsSummary({ member }: { member: QaTeamMember }) {
  const f = member.findings;
  if (!f) return null;
  const counts = [
    f.blockingFindings.length && `${f.blockingFindings.length} blocking`,
    f.actionableNotes.length && `${f.actionableNotes.length} note${f.actionableNotes.length === 1 ? '' : 's'}`,
  ].filter(Boolean);
  return (
    <div className="text-xs text-muted-foreground">
      {f.summary}
      {counts.length > 0 && <span className="text-foreground"> · {counts.join(', ')}</span>}
    </div>
  );
}

export interface QaTeamPanelProps {
  team: QaTeamState;
  teamStatus: TeamStatus;
  teamFinished: boolean;
  entriesFor: (member: QaTeamMember) => TranscriptEntry[];
  runningTools: Record<string, string | null>;
  canStart: boolean;
  starting: boolean;
  onStart: () => void;
  leadChat: React.ReactNode;
  leadActive: boolean;
  past?: boolean;
}

/** QA tab in team mode. */
export function QaTeamPanel({ team, teamStatus, past, ...rest }: QaTeamPanelProps) {
  const lead = QA_LEAD_PERSONA.name;
  const reported = team.members.filter((m) => m.status === 'done').length;
  const finishedNote = past
    ? teamStatus === 'done'
      ? { ok: true, text: 'An earlier QA pass — every reviewer reported.' }
      : { ok: false, text: 'An earlier QA pass — not every reviewer reported.' }
    : teamStatus === 'done'
      ? { ok: true, text: `Every reviewer has reported — ${lead} writes the QA report from their findings.` }
      : { ok: false, text: `Not every reviewer reported — resume the team to retry, or ask ${lead} to write the report without them.` };

  return (
    <TeamPanel
      {...rest}
      label="QA team"
      round={team.round}
      lead={QA_LEAD_PERSONA}
      memberNoun="reviewers"
      personaFor={qaReviewerPersona}
      members={team.members}
      teamStatus={teamStatus}
      past={past}
      progress={{ done: reported, total: team.members.length, label: 'reviews in' }}
      extra={<ChecksRow checks={team.checks} />}
      finishedNote={finishedNote}
      retryLabel="Retry this reviewer"
      renderDetails={(member, persona) => (
        <>
          <CodingPlanChecklist
            title={`${persona.name}'s criteria · ${member.title}`}
            steps={criteriaItems(member)}
            countLabel={(done, total) => `${done} of ${total} met`}
          />
          <PathChips icon={ScanSearch} label="Focus" paths={member.focusPaths} />
          <FindingsSummary member={member} />
        </>
      )}
      emptyHint={(_, persona) => `${persona.name} hasn't started yet.`}
      readOnlyNote={(_, persona) =>
        `${persona.name}'s full log — read only. ${lead} writes the report from every reviewer's findings.`
      }
    />
  );
}

/** QA team rounds that are over (SessionRecord.qaTeamHistory): earlier QA passes. */
export function EarlierQaRounds({ rounds }: { rounds: QaTeamState[] }) {
  return (
    <EarlierRounds
      rounds={rounds}
      kindLabel={() => 'QA pass'}
      doneLabel="Reported"
      memberNoun="reviewers"
      personaFor={qaReviewerPersona}
      renderRound={(team) => (
        <QaTeamPanel
          team={team}
          teamStatus={pastTeamStatus(team.status)}
          teamFinished
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
