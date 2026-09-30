import { promises as fs } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import type { ParsedAttachment } from '../agents/attachments.js';
import { scoreSections, selectSections, splitIntoSections, type DocSection, type ScoredSection } from '../repo/docs-index.js';
import { mutateSession } from './session-store.js';
import type { ReferenceDocsStage, SessionRecord } from './session.js';

// Reference documents: files the human hands the agents once — a vendor API
// spec, a sample file the app ingests — instead of re-attaching them in every
// stage. Two scopes: a session's (every chat attachment lands here
// automatically) and an app's (added on the Apps page, shared by all of its
// sessions). Stored under state/ like meeting sources, never in the target
// repo. Agents reach them through search_docs/read_doc under reference/…
// paths, and each stage is told what's available by a turn note.

export type ReferenceScope = { kind: 'app'; appId: string } | { kind: 'session'; sessionId: string };

export interface ReferenceDoc {
  id: string;
  name: string;
  chars: number;
  addedAt: string;
  scope: 'app' | 'session';
  // What agents pass to read_doc, e.g. reference/session/api-spec-pdf.md.
  path: string;
}

type StoredDoc = Pick<ReferenceDoc, 'id' | 'name' | 'chars' | 'addedAt'>;

// Heading-less text (most PDFs) would otherwise be one enormous section:
// split anything longer into parts so search hits and reads stay small.
const MAX_SECTION_CHARS = 6_000;
// read_doc on something bigger returns an outline instead of the full text.
const MAX_READ_CHARS = 40_000;

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/;

export function isReferenceDocId(id: string): boolean {
  return ID_PATTERN.test(id);
}

function scopeDir(scope: ReferenceScope): string {
  return scope.kind === 'app'
    ? path.join(config.referenceDocsDir, 'apps', scope.appId)
    : path.join(config.referenceDocsDir, 'sessions', scope.sessionId);
}

function scopeKey(scope: ReferenceScope): string {
  return scope.kind === 'app' ? `app:${scope.appId}` : `session:${scope.sessionId}`;
}

function docPath(scope: ReferenceScope, id: string): string {
  return `reference/${scope.kind}/${id}.md`;
}

function docId(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'document'
  );
}

async function readIndex(scope: ReferenceScope): Promise<StoredDoc[]> {
  try {
    return JSON.parse(await fs.readFile(path.join(scopeDir(scope), 'index.json'), 'utf8')) as StoredDoc[];
  } catch {
    return [];
  }
}

async function writeIndex(scope: ReferenceScope, docs: StoredDoc[]): Promise<void> {
  await fs.mkdir(scopeDir(scope), { recursive: true });
  await fs.writeFile(path.join(scopeDir(scope), 'index.json'), JSON.stringify(docs, null, 2), 'utf8');
}

// Same per-key queue as session-store.ts's withLock: two uploads in quick
// succession must not both read-modify-write index.json at once.
const locks = new Map<string, Promise<unknown>>();
function withLock<T>(scope: ReferenceScope, fn: () => Promise<T>): Promise<T> {
  const key = scopeKey(scope);
  const run = (locks.get(key) ?? Promise.resolve()).then(fn, fn);
  locks.set(key, run.catch(() => undefined));
  return run;
}

function toReferenceDoc(scope: ReferenceScope, doc: StoredDoc): ReferenceDoc {
  return { ...doc, scope: scope.kind, path: docPath(scope, doc.id) };
}

export async function listReferenceDocs(scope: ReferenceScope): Promise<ReferenceDoc[]> {
  return (await readIndex(scope)).map((d) => toReferenceDoc(scope, d));
}

/** Adds each file, replacing any existing one with the same name. */
export async function addReferenceDocs(scope: ReferenceScope, files: ParsedAttachment[]): Promise<ReferenceDoc[]> {
  if (files.length === 0) return [];
  return withLock(scope, async () => {
    const docs = await readIndex(scope);
    const added: StoredDoc[] = [];
    await fs.mkdir(scopeDir(scope), { recursive: true });
    for (const file of files) {
      const id = docId(file.name);
      await fs.writeFile(path.join(scopeDir(scope), `${id}.md`), file.text, 'utf8');
      const doc: StoredDoc = { id, name: file.name, chars: file.text.length, addedAt: new Date().toISOString() };
      const at = docs.findIndex((d) => d.id === id);
      if (at >= 0) docs[at] = doc;
      else docs.push(doc);
      added.push(doc);
    }
    await writeIndex(scope, docs);
    sectionCache.delete(scopeKey(scope));
    return added.map((d) => toReferenceDoc(scope, d));
  });
}

export async function removeReferenceDoc(scope: ReferenceScope, id: string): Promise<boolean> {
  return withLock(scope, async () => {
    const docs = await readIndex(scope);
    const remaining = docs.filter((d) => d.id !== id);
    if (remaining.length === docs.length) return false;
    await fs.rm(path.join(scopeDir(scope), `${id}.md`), { force: true });
    await writeIndex(scope, remaining);
    sectionCache.delete(scopeKey(scope));
    return true;
  });
}

export async function removeAllReferenceDocs(scope: ReferenceScope): Promise<void> {
  await withLock(scope, () => fs.rm(scopeDir(scope), { recursive: true, force: true }));
  sectionCache.delete(scopeKey(scope));
}

async function readDocText(scope: ReferenceScope, id: string): Promise<string> {
  return fs.readFile(path.join(scopeDir(scope), `${id}.md`), 'utf8');
}

/** Split children inherit their parent's documents. */
export async function copyReferenceDocs(from: ReferenceScope, to: ReferenceScope): Promise<void> {
  const docs = await readIndex(from);
  const files = await Promise.all(docs.map(async (d) => ({ name: d.name, text: await readDocText(from, d.id) })));
  await addReferenceDocs(to, files);
}

/** Moves one of a session's documents to its app, so every session of that app gets it. */
export async function shareWithApp(sessionId: string, appId: string, id: string): Promise<ReferenceDoc | null> {
  const from: ReferenceScope = { kind: 'session', sessionId };
  const doc = (await readIndex(from)).find((d) => d.id === id);
  if (!doc) return null;
  const [shared] = await addReferenceDocs({ kind: 'app', appId }, [{ name: doc.name, text: await readDocText(from, id) }]);
  await removeReferenceDoc(from, id);
  return shared;
}

// ---- Search/read for search_docs and read_doc ----

const sectionCache = new Map<string, DocSection[]>();

function chunk(section: DocSection): DocSection[] {
  if (section.content.length <= MAX_SECTION_CHARS) return [section];
  const parts: string[] = [];
  let current = '';
  for (const para of section.content.split(/\n\s*\n/)) {
    if (current && current.length + para.length > MAX_SECTION_CHARS) {
      parts.push(current);
      current = '';
    }
    // A single paragraph longer than the cap (PDF text often has no blank lines).
    for (let i = 0; i < para.length; i += MAX_SECTION_CHARS) {
      const piece = para.slice(i, i + MAX_SECTION_CHARS);
      if (current && current.length + piece.length > MAX_SECTION_CHARS) {
        parts.push(current);
        current = '';
      }
      current = current ? `${current}\n\n${piece}` : piece;
    }
  }
  if (current) parts.push(current);
  return parts.map((content, i) => ({ ...section, heading: `${section.heading} (part ${i + 1} of ${parts.length})`, content }));
}

async function scopeSections(scope: ReferenceScope): Promise<DocSection[]> {
  const key = scopeKey(scope);
  const cached = sectionCache.get(key);
  if (cached) return cached;
  const sections: DocSection[] = [];
  for (const doc of await readIndex(scope)) {
    const text = await readDocText(scope, doc.id).catch(() => '');
    sections.push(...splitIntoSections(docPath(scope, doc.id), text).flatMap(chunk));
  }
  sectionCache.set(key, sections);
  return sections;
}

function scopesFor(appId: string, sessionId?: string): ReferenceScope[] {
  return [{ kind: 'app', appId }, ...(sessionId ? [{ kind: 'session' as const, sessionId }] : [])];
}

export async function searchReferenceDocs(appId: string, sessionId: string | undefined, query: string, k: number): Promise<ScoredSection[]> {
  const sections = (await Promise.all(scopesFor(appId, sessionId).map(scopeSections))).flat();
  return scoreSections(sections, query, k);
}

export async function readReferenceDoc(
  appId: string,
  sessionId: string | undefined,
  relPath: string,
  heading?: string
): Promise<string | null> {
  const kind = relPath.startsWith('reference/app/') ? 'app' : relPath.startsWith('reference/session/') ? 'session' : null;
  if (!kind || (kind === 'session' && !sessionId)) return null;
  const scope: ReferenceScope = kind === 'app' ? { kind, appId } : { kind, sessionId: sessionId! };
  const matches = selectSections(await scopeSections(scope), relPath, heading);
  if (!matches) return null;

  const total = matches.reduce((n, s) => n + s.content.length, 0);
  if (total > MAX_READ_CHARS) {
    const outline = matches.map((s) => `- ${s.heading} (${s.content.length.toLocaleString()} chars)`).join('\n');
    return (
      `${relPath}${heading ? ` > ${heading}` : ''} is ${total.toLocaleString()} characters — too long to return at once. ` +
      `Search it with search_docs, or call read_doc again with one of these headings:\n\n${outline}`
    );
  }
  return matches.map((s) => `## ${s.heading}\n\n${s.content}`).join('\n\n---\n\n');
}

// ---- Telling each stage what it has ----

export async function listSessionReferenceDocs(session: Pick<SessionRecord, 'id' | 'appId'>): Promise<ReferenceDoc[]> {
  const [app, own] = await Promise.all(
    scopesFor(session.appId, session.id).map((scope) => listReferenceDocs(scope))
  );
  return [...app, ...own];
}

export function referenceDocsManifest(docs: ReferenceDoc[]): string {
  if (docs.length === 0) return '';
  const lines = docs.map(
    (d) =>
      `- ${d.path} — "${d.name}" (${d.chars.toLocaleString()} characters${d.scope === 'app' ? ', provided for every session of this app' : ''})`
  );
  return (
    `# Reference documents\n\nThe human has already provided these documents. Don't ask for them to be attached ` +
    `again — search them with search_docs and read them with read_doc (pass a heading for long ones):\n\n${lines.join('\n')}`
  );
}

function signature(docs: ReferenceDoc[]): string {
  return docs.map((d) => `${d.path}@${d.addedAt}`).join('|');
}

/**
 * The block to put in front of this turn's prompt, or '' when the stage has
 * already been told about exactly this set of documents. Rides in the turn
 * prompt rather than the system prompt so it reaches a resumed "claude"
 * session too (resume ignores a new system prompt), and is only repeated
 * when the set changes, so it isn't re-billed every turn.
 */
export async function referenceDocsTurnNote(session: SessionRecord, stage: ReferenceDocsStage, isFirstTurn: boolean): Promise<string> {
  const docs = await listSessionReferenceDocs(session);
  const sig = signature(docs);
  const seen = isFirstTurn ? '' : (session.referenceDocsSeen[stage] ?? '');
  if (sig === seen) return '';

  await mutateSession(session.id, (s) => {
    s.referenceDocsSeen[stage] = sig;
  });
  session.referenceDocsSeen[stage] = sig;
  return docs.length > 0
    ? referenceDocsManifest(docs)
    : '# Reference documents\n\nThe reference documents listed earlier have been removed — don\'t rely on them any more.';
}
