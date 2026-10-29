'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { GraduationCap, Loader2, RotateCcw } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { api } from '@/lib/dev-sessions/api';
import { sessionHref } from '@/lib/dev-sessions/stage';
import type { AppLesson, SuggestionStatus } from '@/lib/dev-sessions/types';
import { CollapsibleSection } from './CollapsibleSection';
import { ErrorText } from './PageShell';

/**
 * Bridget's look back once a branch is delivered (harness-server retrospective/):
 * why QA sent it back, the lessons that now go into every agent's briefing for
 * this app (each can be turned off), and suggestions for Riff itself.
 */
export function RetrospectivePanel({
  sessionId,
  appId,
  version,
}: {
  sessionId: string;
  appId: string;
  version: string;
}) {
  const client = useQueryClient();
  const retro = useQuery({
    queryKey: ['retrospective', sessionId, version],
    queryFn: () => api.getRetrospective(sessionId),
    // It runs in the background after delivery: look again while it's running.
    refetchInterval: (q) => (q.state.data?.running ? 3000 : false),
  });
  const lessons = useQuery({ queryKey: ['app-lessons', appId], queryFn: () => api.getAppLessons(appId) });
  const rerun = useMutation({
    mutationFn: () => api.runRetrospective(sessionId),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['retrospective', sessionId] });
      void client.invalidateQueries({ queryKey: ['app-lessons', appId] });
    },
  });
  const toggle = useMutation({
    mutationFn: (v: { id: string; status: 'active' | 'dismissed' }) => api.setAppLessonStatus(appId, v.id, v.status),
    onSuccess: (data) => client.setQueryData(['app-lessons', appId], data),
  });

  const suggest = useMutation({
    mutationFn: (v: { key: string; status: SuggestionStatus }) => api.setSuggestionStatus(appId, v.key, v.status),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['retrospective', sessionId] }),
  });

  const router = useRouter();
  const implement = useMutation({
    mutationFn: async (s: { key: string; title: string; detail: string }) => {
      const riff = await api.getRiffApp();
      const session = await api.createSession({
        title: `Riff: ${s.title}`.slice(0, 120),
        appId: riff.id,
        source: {
          kind: 'suggestion',
          meetingId: `suggestion:${s.key}`,
          meetingTitle: s.title,
          transcript: s.detail || s.title,
        },
      });
      void api.setSuggestionStatus(appId, s.key, 'done');
      return session;
    },
    onSuccess: (session) => router.push(sessionHref(session.id, 'requirements')),
  });
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const apply = useMutation({
    mutationFn: (keys: string[]) => api.applySuggestions(appId, keys),
    onSuccess: () => {
      setPicked(new Set());
      void client.invalidateQueries({ queryKey: ['retrospective', sessionId] });
      void client.invalidateQueries({ queryKey: ['app-lessons', appId] });
    },
  });
  const togglePick = (key: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  const r = retro.data?.retrospective;
  const running = rerun.isPending || Boolean(retro.data?.running);
  if (!r) {
    return (
      <div className="mt-3 text-xs text-muted-foreground">
        {running ? (
          <div className="flex items-center gap-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Bridget is looking back at how QA went… this takes about a
            minute.
          </div>
        ) : (
          <div className="flex items-center gap-2">
            {rerun.isError ? 'The retrospective failed.' : 'No retrospective yet.'}
            <Button size="sm" variant="ghost" onClick={() => rerun.mutate()}>
              {rerun.isError ? 'Try again' : 'Run now'}
            </Button>
          </div>
        )}
        <ErrorText>{rerun.error instanceof Error ? rerun.error.message : null}</ErrorText>
      </div>
    );
  }

  const byId = new Map((lessons.data ?? []).map((l) => [l.id, l]));
  const clean = r.facts.failedPasses === 0;
  return (
    <div className="mt-3">
      <CollapsibleSection
        icon={GraduationCap}
        title="Retrospective"
        aside={clean ? 'clean' : `${r.facts.passes} passes`}
        defaultOpen={!clean}
      >
        <div className="space-y-3 text-sm">
          {clean ? (
            <p className="text-muted-foreground">QA passed first time, so there’s nothing to learn from this one.</p>
          ) : (
            <>
              {r.summary && <p>{r.summary}</p>}
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(r.facts.byCategory).map(([k, n]) => (
                  <Badge key={k} variant="outline">
                    {k.replace(/-/g, ' ')} · {n}
                  </Badge>
                ))}
                {r.facts.unchangedResends.length > 0 && (
                  <Badge variant="outline">
                    send-back changed nothing · pass {r.facts.unchangedResends.join(', ')}
                  </Badge>
                )}
              </div>
            </>
          )}

          {r.lessons.length > 0 && (
            <div>
              <div className="font-medium">Lessons for this app’s agents</div>
              <ul className="mt-1 space-y-1">
                {r.lessons.map((l) => {
                  const live = byId.get(l.id);
                  const off = live?.status === 'dismissed';
                  return (
                    <li key={l.id} className="flex items-start gap-2">
                      <span className={off ? 'text-muted-foreground line-through' : ''}>
                        {l.text}
                        {live && live.seen > 1 && (
                          <span className="text-muted-foreground"> (seen in {live.seen} sessions)</span>
                        )}
                        {live && <EffectBadge lesson={live} />}
                      </span>
                      {live && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="shrink-0"
                          disabled={toggle.isPending}
                          onClick={() => toggle.mutate({ id: l.id, status: off ? 'active' : 'dismissed' })}
                        >
                          {off ? 'Turn on' : 'Turn off'}
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
              <div className="mt-1 text-xs text-muted-foreground">
                Active lessons are in the plan, coding and QA briefings of this app’s next sessions.
              </div>
            </div>
          )}

          {(r.lessonsRetired.length > 0 || r.suggestionsMuted.length > 0) && (
            <div className="rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
              {r.lessonsRetired.map((l) => (
                <div key={l.id}>
                  Bridget took a lesson out of the briefings: “{l.text}” — {l.reason}.
                </div>
              ))}
              {r.suggestionsMuted.map((m) => (
                <div key={m.key}>
                  Bridget stopped raising “{m.title}” — {m.reason}.
                </div>
              ))}
            </div>
          )}

          {r.suggestions.length > 0 && (
            <div>
              <div className="flex items-center justify-between gap-2">
                <div className="font-medium">Suggestions for improving Riff</div>
                <Button
                  size="sm"
                  disabled={picked.size === 0 || apply.isPending}
                  onClick={() => apply.mutate([...picked])}
                >
                  {apply.isPending && <Loader2 className="animate-spin" />} Apply selected
                  {picked.size > 0 ? ` (${picked.size})` : ''} to next run
                </Button>
              </div>
              <ErrorText>{implement.error instanceof Error ? implement.error.message : null}</ErrorText>
              <ErrorText>{apply.error instanceof Error ? apply.error.message : null}</ErrorText>
              <ul className="mt-1 space-y-2">
                {r.suggestions.map((s, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      className="mt-1 shrink-0"
                      aria-label={`Select: ${s.title}`}
                      disabled={s.status === 'done'}
                      checked={picked.has(s.key)}
                      onChange={() => togglePick(s.key)}
                    />
                    <div>
                      <span className="font-medium">{s.title}</span>
                      {s.seenIn > 1 && (
                        <Badge variant="outline" className="ml-2">
                          seen in {s.seenIn} sessions
                        </Badge>
                      )}
                      {s.status === 'done' && (
                        <Badge variant="outline" className="ml-2">
                          {s.verdict === 'not-effective'
                            ? 'marked done, but it keeps coming back'
                            : s.verdict === 'effective'
                              ? 'marked done, and it helped'
                              : 'marked done'}
                        </Badge>
                      )}
                      <div className="text-muted-foreground">{s.detail}</div>
                      <div className="mt-1 flex gap-1">
                        {s.status !== 'done' && (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={suggest.isPending}
                            onClick={() => suggest.mutate({ key: s.key, status: 'done' })}
                          >
                            Mark done
                          </Button>
                        )}
                        {s.status !== 'done' && (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={implement.isPending}
                            onClick={() => implement.mutate(s)}
                          >
                            Start Dev Session
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={suggest.isPending}
                          onClick={() => suggest.mutate({ key: s.key, status: 'dismissed' })}
                        >
                          Stop suggesting this
                        </Button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
              <div className="mt-1 text-xs text-muted-foreground">
                Applied suggestions go into the plan, coding and QA briefings of this app’s next sessions as lessons,
                and show up under lessons above.
              </div>
            </div>
          )}

          <Button size="sm" variant="ghost" onClick={() => rerun.mutate()} disabled={running}>
            {running ? <Loader2 className="animate-spin" /> : <RotateCcw />} {running ? 'Running…' : 'Run again'}
          </Button>
          <ErrorText>{rerun.error instanceof Error ? rerun.error.message : null}</ErrorText>
        </div>
      </CollapsibleSection>
    </div>
  );
}

/** How a lesson is doing: in how many sessions it was briefed, and how often the mistake still came back. */
function EffectBadge({ lesson }: { lesson: AppLesson }) {
  const n = lesson.exposedSessionIds.length;
  const back = lesson.recurredSessionIds.length;
  if (lesson.status === 'retired')
    return (
      <Badge variant="outline" className="ml-2">
        retired: {lesson.retiredReason}
      </Badge>
    );
  if (lesson.verdict === 'unproven')
    return (
      <Badge variant="outline" className="ml-2">
        {n === 0 ? 'not tested yet' : `testing: ${back} of ${n} sessions`}
      </Badge>
    );
  const label = lesson.verdict === 'working' ? 'working' : lesson.verdict === 'mixed' ? 'mixed' : 'not working';
  return (
    <Badge variant="outline" className="ml-2">
      {label}: came back in {back} of {n}
    </Badge>
  );
}
