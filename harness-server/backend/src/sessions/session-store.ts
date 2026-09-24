import { promises as fs } from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config.js';
import type { ModelMessage } from 'ai';
import type { SessionMeetingSource, SessionRecord, SessionStage, TranscriptEntry } from './session.js';
import { slugify } from './session.js';
import { LEGACY_APP_ID } from '../apps/apps.js';

type StageKey = 'requirements' | 'plan' | 'coding' | 'qa';

function sessionFilePath(id: string): string {
  return path.join(config.sessionsStateDir, `${id}.json`);
}

// One turn fires many concurrent, unawaited writes to the same session file
// (coding-agent.ts's wrappedOnEvent calls persistEvent without awaiting it
// for every tool_call/tool_result, while a tool's own execute() may itself
// call updateSession — e.g. write_coding_plan) — plain unsynchronized
// read-modify-write let two of those race, corrupting the file mid-write
// ("Unexpected end of JSON input" on the next read). Serialize all mutating
// operations per session id so they queue instead of interleaving. A
// rejection in one operation must not wedge the queue for the next one, so
// the stored promise is always settled via .catch.
const locks = new Map<string, Promise<unknown>>();

function withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(id) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  locks.set(id, run.catch(() => undefined));
  return run;
}

// Session state is local, disposable dev-tool state (see CLAUDE.md) — not
// worth a migration system, but this keeps an older file on disk from
// crashing a session-shaped field added later.
function normalizeSession(session: SessionRecord): SessionRecord {
  session.appId ??= LEGACY_APP_ID;
  session.histories ??= { requirements: [], plan: [], coding: [], qa: [] };
  session.histories.plan ??= [];
  session.claudeSessionIds ??= { requirements: null, plan: null, coding: null, qa: null };
  session.claudeSessionIds.plan ??= null;
  session.transcripts.plan ??= [];
  session.codingPlan ??= null;
  session.planPath ??= null;
  session.planStatus ??= null;
  session.coordinatorEnabled ??= false;
  session.qaFindingsPending ??= false;
  session.reopenedFromCoding ??= false;
  session.pendingRequirementsRelayNote ??= null;
  session.requirementsRelayPending ??= false;
  session.planRelayPending ??= false;
  session.codingReconciliationPending ??= false;
  session.sourceMeeting ??= null;
  session.meetingKickoffPending ??= false;
  return session;
}

async function ensureStateDir(): Promise<void> {
  await fs.mkdir(config.sessionsStateDir, { recursive: true });
}

export async function listSessions(): Promise<SessionRecord[]> {
  await ensureStateDir();
  const files = await fs.readdir(config.sessionsStateDir);
  const sessions: SessionRecord[] = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const raw = await fs.readFile(path.join(config.sessionsStateDir, file), 'utf8');
    sessions.push(normalizeSession(JSON.parse(raw)));
  }
  return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

async function readSession(id: string): Promise<SessionRecord | null> {
  try {
    const raw = await fs.readFile(sessionFilePath(id), 'utf8');
    return normalizeSession(JSON.parse(raw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

// Public read path doesn't need the lock — it's only the read-modify-write
// sequences below that can race each other; a plain read is always
// consistent since saveSession's rename is atomic.
export async function getSession(id: string): Promise<SessionRecord | null> {
  return readSession(id);
}

// Only this project's own state — the route handler is responsible for
// cleaning up the artifact docs (requirements/plan/QA) this session
// produced, since it needs config.harnessRoot to locate them. Never
// touches Customer-EDI: a session's branch and commits (if any) are left
// exactly as they are.
export async function deleteSession(id: string): Promise<void> {
  return withLock(id, async () => {
    await fs.rm(sessionFilePath(id), { force: true });
  });
}

async function saveSession(session: SessionRecord): Promise<void> {
  await ensureStateDir();
  session.updatedAt = new Date().toISOString();
  const filePath = sessionFilePath(session.id);
  // Write to a temp file and rename over the target — rename is atomic on
  // the same filesystem, so a reader never sees a partially-written file,
  // even without the lock above (belt and suspenders).
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(session, null, 2), 'utf8');
  await fs.rename(tmpPath, filePath);
}

export async function createSession(input: {
  id?: string;
  title: string;
  sessionKey?: string;
  appId: string;
  sourceMeeting?: SessionMeetingSource | null;
}): Promise<SessionRecord> {
  const now = new Date().toISOString();
  const sessionKey = input.sessionKey?.trim() || slugify(input.title);
  const session: SessionRecord = {
    id: input.id ?? uuidv4(),
    sessionKey,
    title: input.title,
    appId: input.appId,
    stage: 'requirements-in-progress',
    requirementsPath: null,
    requirementsStatus: null,
    planPath: null,
    planStatus: null,
    branch: null,
    codingApprovedAt: null,
    codingPlan: null,
    qaReportPath: null,
    qaStatus: null,
    coordinatorEnabled: false,
    qaFindingsPending: false,
    reopenedFromCoding: false,
    pendingRequirementsRelayNote: null,
    requirementsRelayPending: false,
    planRelayPending: false,
    codingReconciliationPending: false,
    sourceMeeting: input.sourceMeeting ?? null,
    meetingKickoffPending: Boolean(input.sourceMeeting),
    transcripts: { requirements: [], plan: [], coding: [], qa: [] },
    histories: { requirements: [], plan: [], coding: [], qa: [] },
    claudeSessionIds: { requirements: null, plan: null, coding: null, qa: null },
    createdAt: now,
    updatedAt: now,
  };
  await saveSession(session);
  return session;
}

export async function updateSession(
  id: string,
  patch: Partial<Omit<SessionRecord, 'id' | 'transcripts' | 'createdAt'>>
): Promise<SessionRecord> {
  return withLock(id, async () => {
    const session = await readSession(id);
    if (!session) throw new Error(`Session ${id} not found`);
    Object.assign(session, patch);
    await saveSession(session);
    return session;
  });
}

export async function setStage(id: string, stage: SessionStage): Promise<SessionRecord> {
  return updateSession(id, { stage });
}

export async function setHistory(id: string, stage: StageKey, history: ModelMessage[]): Promise<SessionRecord> {
  return withLock(id, async () => {
    const session = await readSession(id);
    if (!session) throw new Error(`Session ${id} not found`);
    session.histories[stage] = history;
    await saveSession(session);
    return session;
  });
}

export async function setClaudeSessionId(id: string, stage: StageKey, sdkSessionId: string | null): Promise<SessionRecord> {
  return withLock(id, async () => {
    const session = await readSession(id);
    if (!session) throw new Error(`Session ${id} not found`);
    session.claudeSessionIds[stage] = sdkSessionId;
    await saveSession(session);
    return session;
  });
}

export async function appendTranscriptEntry(
  id: string,
  stage: StageKey,
  entry: Omit<TranscriptEntry, 'id' | 'timestamp'>
): Promise<TranscriptEntry> {
  return withLock(id, async () => {
    const session = await readSession(id);
    if (!session) throw new Error(`Session ${id} not found`);
    const full: TranscriptEntry = { ...entry, id: uuidv4(), timestamp: new Date().toISOString() };
    session.transcripts[stage].push(full);
    await saveSession(session);
    return full;
  });
}
