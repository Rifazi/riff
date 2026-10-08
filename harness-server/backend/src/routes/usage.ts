import type { FastifyInstance } from 'fastify';
import { listSessions } from '../sessions/session-store.js';
import { listApps } from '../apps/apps-store.js';
import { readUsageLog, type UsageLogEntry, type UsageStage } from '../sessions/usage-log.js';
import { addUsage, ZERO_USAGE, type TokenUsage, type ToolOutputStats } from '../agents/sdk-client.js';
import type { HelperName, SessionRecord } from '../sessions/session.js';

// Token usage for Settings → Dev Agents. Built from the per-turn usage log
// (sessions/usage-log.ts). Sessions older than the log only have running
// totals, so whatever their totals exceed the log by is dated to the
// stage's last activity before logging began and flagged `estimated`.

// One local helper's runs in the range (agents/helpers/).
interface LocalHelperTotals {
  calls: number;
  tasks: number;
  useful: number;
  usage: TokenUsage;
  savedTokens: number;
}

const STAGES: UsageStage[] = ['requirements', 'plan', 'coding', 'qa'];
const RANGES = [7, 30, 90] as const;

interface UsageRecord {
  at: string;
  sessionId: string;
  stage: UsageStage;
  usage: TokenUsage;
  toolOutput?: ToolOutputStats;
  estimated: boolean;
}

type ByStage = Record<UsageStage, number>;

const total = (u: TokenUsage) => u.input + u.output + u.cacheRead + u.cacheWrite;
const zeroByStage = (): ByStage => ({ requirements: 0, plan: 0, coding: 0, qa: 0 });

function subtract(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: Math.max(0, a.input - b.input),
    output: Math.max(0, a.output - b.output),
    cacheRead: Math.max(0, a.cacheRead - b.cacheRead),
    cacheWrite: Math.max(0, a.cacheWrite - b.cacheWrite),
  };
}

function stageTimestamps(session: SessionRecord, stage: UsageStage): string[] {
  const own = session.transcripts[stage].map((e) => e.timestamp);
  if (stage !== 'coding') return own;
  const teams = [...session.codingTeamHistory, ...(session.codingTeam ? [session.codingTeam] : [])];
  return [...own, ...teams.flatMap((t) => t.members.flatMap((m) => m.transcript.map((e) => e.timestamp)))];
}

/** Local calendar day, YYYY-MM-DD — the server runs on the user's own machine. */
function localDay(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function usageRecords(sessions: SessionRecord[], log: UsageLogEntry[]): Promise<UsageRecord[]> {
  const records: UsageRecord[] = log.map((e) => ({ ...e, estimated: false }));

  for (const session of sessions) {
    for (const stage of STAGES) {
      const logged = log.filter((e) => e.sessionId === session.id && e.stage === stage);
      const missing = subtract(session.usage[stage], logged.reduce((acc, e) => addUsage(acc, e.usage), ZERO_USAGE));
      if (total(missing) === 0) continue;
      const firstLogged = logged.reduce<string | null>((min, e) => (!min || e.at < min ? e.at : min), null);
      const before = stageTimestamps(session, stage).filter((t) => !firstLogged || t < firstLogged).sort();
      records.push({
        at: before.at(-1) ?? session.updatedAt,
        sessionId: session.id,
        stage,
        usage: missing,
        estimated: true,
      });
    }
  }
  return records;
}

export async function registerUsageRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { days?: string } }>('/api/usage', async (request) => {
    const requested = Number(request.query.days);
    const days = (RANGES as readonly number[]).includes(requested) ? requested : 30;

    const [sessions, apps, log] = await Promise.all([listSessions(), listApps(), readUsageLog()]);
    // Local helper runs (agents/helpers/) cost nothing: reported on their
    // own, never in the paid totals (or the estimate, which compares the log
    // with each session's paid running totals).
    const records = await usageRecords(sessions, log.filter((e) => !e.helper));

    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - (days - 1));
    const inRange = records.filter((r) => new Date(r.at) >= start);

    const daily = new Map<string, { date: string; byStage: ByStage; estimated: number }>();
    for (let i = 0; i < days; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const date = localDay(d);
      daily.set(date, { date, byStage: zeroByStage(), estimated: 0 });
    }

    const byStage: Record<UsageStage, TokenUsage> = { requirements: ZERO_USAGE, plan: ZERO_USAGE, coding: ZERO_USAGE, qa: ZERO_USAGE };
    // Tool output only exists on turns logged since it was tracked.
    const byTool = new Map<string, { calls: number; chars: number }>();
    const bySession = new Map<string, { byStage: ByStage; usage: TokenUsage; turns: number; lastAt: string }>();
    for (const r of inRange) {
      const t = total(r.usage);
      const day = daily.get(localDay(new Date(r.at)));
      if (day) {
        day.byStage[r.stage] += t;
        if (r.estimated) day.estimated += t;
      }
      byStage[r.stage] = addUsage(byStage[r.stage], r.usage);
      for (const [tool, s] of Object.entries(r.toolOutput ?? {})) {
        const acc = byTool.get(tool) ?? { calls: 0, chars: 0 };
        acc.calls += s.calls;
        acc.chars += s.chars;
        byTool.set(tool, acc);
      }
      const s = bySession.get(r.sessionId) ?? { byStage: zeroByStage(), usage: ZERO_USAGE, turns: 0, lastAt: r.at };
      s.byStage[r.stage] += t;
      s.usage = addUsage(s.usage, r.usage);
      if (!r.estimated) s.turns += 1;
      if (r.at > s.lastAt) s.lastAt = r.at;
      bySession.set(r.sessionId, s);
    }

    const byHelper: Partial<Record<HelperName, LocalHelperTotals>> = {};
    for (const e of log) {
      if (!e.helper || new Date(e.at) < start) continue;
      const h = (byHelper[e.helper.name] ??= { calls: 0, tasks: 0, useful: 0, usage: ZERO_USAGE, savedTokens: 0 });
      if (!e.helper.redo) h.calls += 1;
      h.tasks += e.helper.tasks;
      h.useful += e.helper.useful;
      h.usage = addUsage(h.usage, e.usage);
      h.savedTokens += e.helper.savedTokens;
    }
    const helpers = Object.values(byHelper);
    const local = {
      calls: helpers.reduce((acc, h) => acc + h.calls, 0),
      savedTokens: helpers.reduce((acc, h) => acc + h.savedTokens, 0),
      usage: helpers.reduce((acc, h) => addUsage(acc, h.usage), ZERO_USAGE),
      byHelper,
    };

    const sessionById = new Map(sessions.map((s) => [s.id, s]));
    const appName = new Map(apps.map((a) => [a.id, a.name]));
    const logged = records.filter((r) => !r.estimated);

    return {
      days,
      since: start.toISOString(),
      // When per-turn logging began; earlier usage is estimated.
      trackedSince: logged.reduce<string | null>((min, r) => (!min || r.at < min ? r.at : min), null),
      totals: {
        usage: STAGES.reduce((acc, s) => addUsage(acc, byStage[s]), ZERO_USAGE),
        byStage,
        estimated: inRange.filter((r) => r.estimated).reduce((acc, r) => acc + total(r.usage), 0),
        sessions: bySession.size,
      },
      daily: [...daily.values()],
      local,
      toolOutput: [...byTool.entries()].map(([tool, s]) => ({ tool, ...s })).sort((a, b) => b.chars - a.chars),
      sessions: [...bySession.entries()]
        .map(([id, s]) => {
          const session = sessionById.get(id);
          return {
            id,
            title: session?.title ?? 'Deleted session',
            appName: session ? (appName.get(session.appId) ?? session.appId) : null,
            exists: Boolean(session),
            lastAt: s.lastAt,
            turns: s.turns,
            byStage: s.byStage,
            usage: s.usage,
          };
        })
        .sort((a, b) => total(b.usage) - total(a.usage)),
    };
  });
}
