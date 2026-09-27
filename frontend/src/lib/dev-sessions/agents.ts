import type { StageGroup } from './stage';

export interface AgentPersona {
  /** First name — what's actually shown in the UI. */
  name: string;
  /** The full pun name (e.g. "Anna Lyzer" → analyzer) — surfaced only as a hover tooltip. */
  fullName: string;
  title: string;
  initials: string;
}

// Purely cosmetic identities for the chat UI — give each role a face so the
// human is clearly talking to someone, not a bare "agent". The full name
// (see fullName, on hover) winks at what the role actually does: Anna Lyzer
// digs into requirements, Justin Time keeps the plan on schedule, Jack
// Overflow writes the code, Tess Case breaks it, Bridget Gapp bridges
// stages. Backend role keys (requirements/plan/coding/qa/coordinator) are
// unaffected; this is presentation only.
export const AGENT_PERSONAS: Record<StageGroup, AgentPersona> = {
  requirements: { name: 'Anna', fullName: 'Anna Lyzer', title: 'Requirements Analyst', initials: 'AN' },
  plan: { name: 'Justin', fullName: 'Justin Time', title: 'Planning Lead', initials: 'JU' },
  coding: { name: 'Jack', fullName: 'Jack Overflow', title: 'Software Engineer', initials: 'JA' },
  qa: { name: 'Tess', fullName: 'Tess Case', title: 'QA Engineer', initials: 'TE' },
};

export const COORDINATOR_PERSONA: AgentPersona = {
  name: 'Bridget',
  fullName: 'Bridget Gapp',
  title: 'Session Coordinator',
  initials: 'BR',
};

// The coding team: Jack leads, and each plan workstream gets its own
// engineer, assigned by the workstream's position in the plan so a member
// keeps the same face in the Plan and Coding tabs. Same pun-name
// convention as above; `color` distinguishes the lanes at a glance.
export interface TeamPersona extends AgentPersona {
  color: { avatar: string; ring: string; soft: string; text: string };
}

const TEAM_ROSTER: Omit<TeamPersona, 'title'>[] = [
  { name: 'Ada', fullName: 'Ada Lambda', initials: 'AD', color: { avatar: 'from-emerald-500 to-teal-500', ring: 'border-emerald-300', soft: 'bg-emerald-50', text: 'text-emerald-700' } },
  { name: 'Max', fullName: 'Max Heap', initials: 'MA', color: { avatar: 'from-orange-500 to-amber-500', ring: 'border-orange-300', soft: 'bg-orange-50', text: 'text-orange-700' } },
  { name: 'Rae', fullName: 'Rae Cursion', initials: 'RA', color: { avatar: 'from-pink-500 to-rose-500', ring: 'border-pink-300', soft: 'bg-pink-50', text: 'text-pink-700' } },
  { name: 'Lin', fullName: 'Lin Ter', initials: 'LI', color: { avatar: 'from-sky-500 to-cyan-500', ring: 'border-sky-300', soft: 'bg-sky-50', text: 'text-sky-700' } },
  { name: 'Cass', fullName: 'Cass Cade', initials: 'CA', color: { avatar: 'from-violet-500 to-fuchsia-500', ring: 'border-violet-300', soft: 'bg-violet-50', text: 'text-violet-700' } },
  { name: 'Mo', fullName: 'Mo Dule', initials: 'MO', color: { avatar: 'from-lime-500 to-green-500', ring: 'border-lime-300', soft: 'bg-lime-50', text: 'text-lime-700' } },
];

export function teamMemberPersona(index: number, workstreamTitle: string): TeamPersona {
  const base = TEAM_ROSTER[index % TEAM_ROSTER.length];
  const lap = Math.floor(index / TEAM_ROSTER.length);
  return {
    ...base,
    name: lap ? `${base.name} ${lap + 1}` : base.name,
    title: `Engineer · ${workstreamTitle}`,
  };
}

export const TEAM_LEAD_PERSONA: AgentPersona = { ...AGENT_PERSONAS.coding, title: 'Lead Engineer' };
