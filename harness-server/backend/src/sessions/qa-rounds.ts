import { promises as fs } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { changedFilesBetween, commitBefore, revParse } from '../repo/git.js';
import { parseQaReport } from './qa-findings.js';
import { analyzeQaLoop, findingFiles, findingSimilarity, SAME_FINDING, type QaCriterionRecord, type QaLoopAnalysis, type QaRoundRecord } from './qa-loop.js';
import type { QaTeamState, SessionRecord } from './session.js';
import { updateSession } from './session-store.js';

async function readReport(session: SessionRecord): Promise<string | null> {
  if (!session.qaReportPath) return null;
  try {
    return await fs.readFile(path.join(config.harnessRoot, session.qaReportPath), 'utf8');
  } catch {
    return null;
  }
}

/** Where a pass's copy of the report is kept, harnessRoot-relative. */
export function passReportPath(sessionKey: string, pass: number): string {
  return path.relative(config.harnessRoot, path.join(config.qaReportsDir, 'passes', sessionKey, `pass-${pass}.md`));
}

/** Copies the report on file as this pass's; a rewrite in the same pass replaces it. */
async function keepPassReport(session: SessionRecord, raw: string): Promise<string | undefined> {
  const rel = passReportPath(session.sessionKey, session.qaPass);
  try {
    const abs = path.join(config.harnessRoot, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, raw);
    return rel;
  } catch {
    return undefined;
  }
}

/**
 * Files the current QA report as this pass's round, replacing the pass's
 * earlier record if the lead rewrote the report. Called after every QA turn.
 */
export async function recordQaRound(session: SessionRecord, repoRoot: string): Promise<SessionRecord> {
  const raw = await readReport(session);
  if (!raw || !session.branch) return session;
  const reportPath = await keepPassReport(session, raw);
  const report = parseQaReport(raw);
  const last = session.qaRounds[session.qaRounds.length - 1];
  const head = await revParse(repoRoot, session.branch);
  const previous = last?.pass === session.qaPass ? session.qaRounds[session.qaRounds.length - 2] : last;
  const round: QaRoundRecord = {
    pass: session.qaPass,
    at: new Date().toISOString(),
    result: report.result,
    blocking: report.blocking,
    notes: report.notes,
    head,
    criteria: withCriterionFiles(report.criteria, session.qaTeam, previous),
    reportPath,
  };
  const unchanged =
    last?.pass === round.pass &&
    last.result === round.result &&
    last.head === round.head &&
    last.reportPath === round.reportPath &&
    JSON.stringify([last.blocking, last.notes, last.criteria]) === JSON.stringify([round.blocking, round.notes, round.criteria]);
  if (unchanged) return session;
  const qaRounds = last?.pass === round.pass ? [...session.qaRounds.slice(0, -1), round] : [...session.qaRounds, round];
  return updateSession(session.id, { qaRounds });
}

const sameCriterion = (a: string, b: string) => findingSimilarity(a, b) >= SAME_FINDING || a.trim().toLowerCase() === b.trim().toLowerCase();

/** The reviewers' verdicts, with the files each verdict's note pointed at. */
function reviewerCriteria(team: QaTeamState | null): QaCriterionRecord[] {
  return (team?.members ?? [])
    .flatMap((m) => m.findings?.criteria ?? [])
    .map((c) => ({ text: c.criterion, verdict: c.verdict, files: findingFiles(c.note) }));
}

/**
 * The checklist's criteria with the files their code is in: from the line
 * itself, else the reviewer's note on it, else (carried forward) the previous
 * pass's record of it.
 */
function withCriterionFiles(criteria: QaCriterionRecord[], team: QaTeamState | null, previous: QaRoundRecord | undefined): QaCriterionRecord[] {
  const reviewed = reviewerCriteria(team);
  return criteria.map((c) => {
    if (c.files.length > 0) return c;
    const match = reviewed.find((r) => sameCriterion(r.text, c.text)) ?? previous?.criteria?.find((r) => sameCriterion(r.text, c.text));
    return match && match.files.length > 0 ? { ...c, files: match.files } : c;
  });
}

/** The report's checklist verdicts, with files from the reviewers' records where the line names none. */
function mergeCriteria(fromReport: QaCriterionRecord[], fromReviewers: QaCriterionRecord[] | undefined): QaCriterionRecord[] {
  return fromReport.map((c) => {
    if (c.files.length > 0) return c;
    const match = fromReviewers?.find((r) => sameCriterion(r.text, c.text));
    return match && match.files.length > 0 ? { ...c, files: match.files } : c;
  });
}

function teamRound(team: QaTeamState, pass: number): QaRoundRecord {
  const findings = team.members.map((m) => m.findings).filter((f) => f !== null);
  const blocking = findings.flatMap((f) => f.blockingFindings);
  return {
    pass,
    at: team.finishedAt ?? team.startedAt,
    result: blocking.length > 0 ? 'fail' : null,
    blocking,
    notes: findings.flatMap((f) => f.actionableNotes),
    head: null,
    criteria: reviewerCriteria(team),
  };
}

/** The commit the previous QA pass reviewed, for a re-review's diff scope; null on a first pass. */
export function previousPassRef(session: Pick<SessionRecord, 'qaRounds' | 'qaPass'>): { ref: string; pass: number } | null {
  for (let i = session.qaRounds.length - 1; i >= 0; i--) {
    const r = session.qaRounds[i];
    if (r.pass < session.qaPass && r.head) return { ref: r.head, pass: r.pass };
  }
  return null;
}

/**
 * Every QA pass on this session, oldest first, each with the commit it
 * reviewed where that can be found. Passes from before rounds were recorded
 * are rebuilt from the QA teams' reviewer findings (an approximation: the
 * lead may have dropped or added some), and the current report stands in for
 * the latest pass when nothing recorded it.
 */
export async function qaRoundsFor(session: SessionRecord, repoRoot: string): Promise<QaRoundRecord[]> {
  const recorded = session.qaRounds;
  const firstRecorded = recorded[0]?.pass ?? Infinity;
  const teams = [...session.qaTeamHistory, ...(session.qaTeam ? [session.qaTeam] : [])];
  const rebuilt = teams
    .map((t, i) => (t.finishedAt ? teamRound(t, i + 1) : null))
    .filter((r): r is QaRoundRecord => r !== null && r.pass < firstRecorded);

  if (recorded.length === 0) {
    const raw = await readReport(session);
    if (raw) {
      const report = parseQaReport(raw);
      const written = await fs
        .stat(path.join(config.harnessRoot, session.qaReportPath!))
        .then((s) => s.mtime.toISOString())
        .catch(() => new Date().toISOString());
      const fromReport = { result: report.result, blocking: report.blocking, notes: report.notes, at: written };
      const withCriteria = (r: QaRoundRecord): QaRoundRecord => ({
        ...r,
        ...fromReport,
        criteria: report.criteria.length ? mergeCriteria(report.criteria, r.criteria) : r.criteria,
      });
      // The report belongs to the last pass that finished before it was
      // written, which isn't the latest one while a newer pass is under way.
      let owner = -1;
      for (let i = rebuilt.length - 1; i >= 0; i--) {
        if (rebuilt[i].at <= written) {
          owner = i;
          break;
        }
      }
      if (owner >= 0) rebuilt[owner] = withCriteria(rebuilt[owner]);
      else if (rebuilt.length === 0) rebuilt.push({ pass: session.qaPass, head: null, ...fromReport, criteria: report.criteria });
    }
  }

  const rounds = [...rebuilt, ...recorded];
  if (!session.branch) return rounds;
  return Promise.all(
    rounds.map(async (r) => (r.head ? r : { ...r, head: await commitBefore(repoRoot, session.branch!, r.at) })),
  );
}

async function filesBetween(repoRoot: string, from: string | null, to: string | null): Promise<string[] | null> {
  return from && to ? changedFilesBetween(repoRoot, from, to) : null;
}

/** Why the latest QA pass failed compared with the earlier ones, or null when it didn't fail. */
export async function qaLoopFor(session: SessionRecord, repoRoot: string): Promise<QaLoopAnalysis | null> {
  const rounds = await qaRoundsFor(session, repoRoot);
  const latest = rounds[rounds.length - 1];
  const previous = rounds[rounds.length - 2];
  return analyzeQaLoop(rounds, await filesBetween(repoRoot, previous?.head ?? null, latest?.head ?? null));
}

/** For a re-review: the earlier passes, and the files changed since the last one reviewed the branch. */
export async function rereviewContext(
  session: SessionRecord,
  repoRoot: string,
): Promise<{ rounds: QaRoundRecord[]; fixFiles: string[] | null }> {
  const rounds = await qaRoundsFor(session, repoRoot);
  const head = session.branch ? await revParse(repoRoot, session.branch) : null;
  return { rounds, fixFiles: await filesBetween(repoRoot, rounds[rounds.length - 1]?.head ?? null, head) };
}
