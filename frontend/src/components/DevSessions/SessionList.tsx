'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { ChevronDown, ChevronRight, ExternalLink, GitFork, Loader2, NotebookPen, RotateCcw, Search, Trash2 } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { EmptyState } from '@/components/DevSessions/PageShell';
import { sessionHref, STAGE_LABEL, stageGroupFor } from '@/lib/dev-sessions/stage';
import type { SessionRecord } from '@/lib/dev-sessions/types';

type StatusFilter = 'active' | 'done' | 'rejected' | 'all';

const STATUS_TABS: { value: StatusFilter; label: string }[] = [
  { value: 'active', label: 'Active' },
  { value: 'done', label: 'Done' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'all', label: 'All' },
];

const PREFS_KEY = 'riff.devSessions.listPrefs';

interface Prefs {
  status: StatusFilter;
  appId: string;
  collapsed: string[];
}

function loadPrefs(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}');
    return {
      status: STATUS_TABS.some((t) => t.value === raw.status) ? raw.status : 'active',
      appId: typeof raw.appId === 'string' ? raw.appId : 'all',
      collapsed: Array.isArray(raw.collapsed) ? raw.collapsed : [],
    };
  } catch {
    return { status: 'active', appId: 'all', collapsed: [] };
  }
}

function savePrefs(prefs: Prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Per-viewer convenience only.
  }
}

function statusOf(session: SessionRecord): Exclude<StatusFilter, 'all'> {
  if (session.stage === 'done') return 'done';
  if (session.stage === 'abandoned') return 'rejected';
  return 'active';
}

function stageTone(session: SessionRecord) {
  if (session.stage === 'done') return 'success' as const;
  if (session.stage === 'abandoned') return 'destructive' as const;
  if (session.stage === 'split') return 'secondary' as const;
  if (session.stage.endsWith('approved') || session.stage === 'coding-review' || session.stage === 'qa-reviewed')
    return 'warning' as const;
  return 'info' as const;
}

function matches(session: SessionRecord, query: string) {
  if (!query) return true;
  const haystack = [session.title, session.ticket, session.sessionKey, session.branch, session.sourceMeeting?.meetingTitle]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .every((term) => haystack.includes(term));
}

export function SessionList({
  sessions,
  onReopen,
  onDelete,
  reopeningId,
  deletingId,
}: {
  sessions: SessionRecord[];
  onReopen: (id: string) => void;
  onDelete: (session: SessionRecord) => void;
  reopeningId?: string;
  deletingId?: string;
}) {
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const [query, setQuery] = useState('');

  const update = (patch: Partial<Prefs>) =>
    setPrefs((current) => {
      const next = { ...current, ...patch };
      savePrefs(next);
      return next;
    });

  const sessionsById = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions]);

  const apps = useMemo(() => {
    const byId = new Map<string, string>();
    for (const s of sessions) byId.set(s.appId, s.appName);
    return [...byId].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [sessions]);

  // A saved app filter can outlive its sessions; treat it as "all" then.
  const appFilter = apps.some((a) => a.id === prefs.appId) ? prefs.appId : 'all';

  const counts = useMemo(() => {
    const c = { active: 0, done: 0, rejected: 0, all: 0 };
    for (const s of sessions) {
      if (appFilter !== 'all' && s.appId !== appFilter) continue;
      if (!matches(s, query)) continue;
      c[statusOf(s)]++;
      c.all++;
    }
    return c;
  }, [sessions, appFilter, query]);

  const groups = useMemo(() => {
    const byApp = new Map<string, { appId: string; appName: string; sessions: SessionRecord[] }>();
    for (const s of sessions) {
      if (appFilter !== 'all' && s.appId !== appFilter) continue;
      if (prefs.status !== 'all' && statusOf(s) !== prefs.status) continue;
      if (!matches(s, query)) continue;
      const group = byApp.get(s.appId) ?? { appId: s.appId, appName: s.appName, sessions: [] };
      group.sessions.push(s);
      byApp.set(s.appId, group);
    }
    const list = [...byApp.values()];
    for (const g of list) g.sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    // The app worked on most recently comes first.
    return list.sort((a, b) => b.sessions[0].updatedAt.localeCompare(a.sessions[0].updatedAt));
  }, [sessions, appFilter, prefs.status, query]);

  const searching = query.trim().length > 0;
  const toggleGroup = (appId: string) =>
    update({ collapsed: prefs.collapsed.includes(appId) ? prefs.collapsed.filter((id) => id !== appId) : [...prefs.collapsed, appId] });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder="Search title, ticket or branch"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {apps.length > 1 && (
          <Select value={appFilter} onValueChange={(appId) => update({ appId })}>
            <SelectTrigger className="w-44 bg-card">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All apps</SelectItem>
              {apps.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <div className="inline-flex rounded-md border border-border bg-card p-0.5" role="tablist" aria-label="Session status">
          {STATUS_TABS.map((tab) => (
            <button
              key={tab.value}
              type="button"
              role="tab"
              aria-selected={prefs.status === tab.value}
              onClick={() => update({ status: tab.value })}
              className={`px-3 py-1 text-sm rounded transition-colors ${
                prefs.status === tab.value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {tab.label}
              <span className="ml-1.5 text-xs opacity-70">{counts[tab.value]}</span>
            </button>
          ))}
        </div>
      </div>

      {groups.length === 0 && (
        <EmptyState>
          {sessions.length === 0
            ? 'No sessions yet — start one above or from a meeting.'
            : 'No sessions match these filters.'}
        </EmptyState>
      )}

      {groups.map((group) => {
        // Searching opens every group so a match is never hidden.
        const open = searching || !prefs.collapsed.includes(group.appId);
        return (
          <section key={group.appId}>
            <button
              type="button"
              onClick={() => toggleGroup(group.appId)}
              aria-expanded={open}
              className="flex w-full items-center gap-2 py-1.5 text-left text-sm font-semibold text-foreground"
            >
              {open ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
              {group.appName}
              <span className="text-xs font-normal text-muted-foreground">{group.sessions.length}</span>
            </button>
            {open && (
              <div className="space-y-2">
                {group.sessions.map((session) => (
                  <SessionRow
                    key={session.id}
                    session={session}
                    sessionsById={sessionsById}
                    busyReopen={reopeningId === session.id}
                    busyDelete={deletingId === session.id}
                    onReopen={onReopen}
                    onDelete={onDelete}
                  />
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

function SessionRow({
  session,
  sessionsById,
  busyReopen,
  busyDelete,
  onReopen,
  onDelete,
}: {
  session: SessionRecord;
  sessionsById: Map<string, SessionRecord>;
  busyReopen: boolean;
  busyDelete: boolean;
  onReopen: (id: string) => void;
  onDelete: (session: SessionRecord) => void;
}) {
  const shipped = session.splitInto.filter((id) => sessionsById.get(id)?.stage === 'done').length;
  const splitParent = session.splitFrom ? sessionsById.get(session.splitFrom.sessionId) : undefined;
  const partIndex = splitParent ? splitParent.splitInto.indexOf(session.id) : -1;
  const stop = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <Link
      href={sessionHref(session.id, stageGroupFor(session))}
      className="group flex items-center gap-4 bg-card rounded-lg border border-border px-4 py-3 hover:border-primary/50 hover:shadow-sm transition-all"
    >
      <div className="flex-1 min-w-0">
        <div className="font-medium text-foreground truncate">{session.title}</div>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="font-mono">{session.ticket ?? session.sessionKey}</span>
          {session.splitFrom && (
            <Badge variant="secondary" className="gap-1" title={`Split from "${session.splitFrom.title}"`}>
              <GitFork className="w-3 h-3" />
              {session.splitFrom.sessionKey}
              {partIndex >= 0 && ` · part ${partIndex + 1} of ${splitParent!.splitInto.length}`}
            </Badge>
          )}
          {session.splitInto.length > 0 && (
            <Badge variant={shipped === session.splitInto.length ? 'success' : 'secondary'} className="gap-1">
              <GitFork className="w-3 h-3" />
              {shipped} of {session.splitInto.length} parts shipped
            </Badge>
          )}
          {session.sourceMeeting && (
            <Badge
              variant="info"
              className="gap-1"
              title={session.sourceMeeting.kind === 'journal' ? 'Started from a journal' : 'Started from a meeting transcript'}
            >
              <NotebookPen className="w-3 h-3" />
              {session.sourceMeeting.meetingTitle || 'Meeting'}
            </Badge>
          )}
          <span>Updated {new Date(session.updatedAt).toLocaleString()}</span>
        </div>
      </div>
      <Badge variant={stageTone(session)}>{STAGE_LABEL[session.stage] ?? session.stage}</Badge>
      <div className="flex items-center gap-1">
        {session.stage === 'abandoned' && (
          <Button
            size="sm"
            variant="outline"
            onClick={(e) => {
              stop(e);
              onReopen(session.id);
            }}
            disabled={busyReopen}
            title="Resume this session wherever it was rejected from."
          >
            {busyReopen ? <Loader2 className="animate-spin" /> : <RotateCcw />}
            Reopen
          </Button>
        )}
        <Button
          size="icon"
          variant="ghost"
          className="text-muted-foreground hover:text-destructive hover:bg-destructive/10"
          onClick={(e) => {
            stop(e);
            onDelete(session);
          }}
          disabled={busyDelete}
          aria-label="Delete session"
        >
          {busyDelete ? <Loader2 className="animate-spin" /> : <Trash2 />}
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="text-muted-foreground hover:text-foreground"
          onClick={(e) => {
            stop(e);
            invoke('open_session_window', { sessionId: session.id, title: session.title });
          }}
          aria-label="Open in new window"
          title="Open in new window"
        >
          <ExternalLink className="w-4 h-4" />
        </Button>
        <ChevronRight className="w-4 h-4 text-muted-foreground/60 group-hover:text-muted-foreground" />
      </div>
    </Link>
  );
}
