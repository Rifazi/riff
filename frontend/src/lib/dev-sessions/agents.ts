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
