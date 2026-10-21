'use client';

import { GraduationCap, Loader2, RotateCcw } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { api } from '@/lib/dev-sessions/api';
import type { AppLesson, SuggestionStatus } from '@/lib/dev-sessions/types';
import { CollapsibleSection } from './CollapsibleSection';
import { ErrorText } from './PageShell';

/**
 * Bridget's look back once a branch is delivered (harness-server retrospective/):
 * why QA sent it back, the lessons that now go into every agent's briefing for
 * this app (each can be turned off), and suggestions for Riff itself.
 */
export function RetrospectivePanel({ sessionId, appId, version }: { sessionId: string; appId: string; version: string }) {
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

  const r = retro.data?.retrospective;
  const running = rerun.isPending || Boolean(retro.data?.running);
  if (!r) {
    return (
      <div className="mt-3 text-xs text-muted-foreground">
        {running ? (
          <div className="flex items-center gap-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Bridget is looking back at how QA went… this takes about a minute.
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
                {r.facts.unchangedResends.length > 0 && <Badge variant="outline">send-back changed nothing · pass {r.facts.unchangedResends.join(', ')}</Badge>}
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
                        {live && live.seen > 1 && <span className="text-muted-foreground"> (seen in {live.seen} sessions)</span>}
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
              <div className="mt-1 text-xs text-muted-foreground">Active lessons are in the plan, coding and QA briefings of this app’s next sessions.</div>
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
              <div className="font-medium">Suggestions for improving Riff</div>
              <ul className="mt-1 space-y-2">
                {r.suggestions.map((s, i) => (
                  <li key={i}>
                    <span className="font-medium">{s.title}</span>
                    {s.seenIn > 1 && <Badge variant="outline" className="ml-2">seen in {s.seenIn} sessions</Badge>}
                    {s.status === 'done' && (
                      <Badge variant="outline" className="ml-2">
                        {s.verdict === 'not-effective' ? 'marked done, but it keeps coming back' : s.verdict === 'effective' ? 'marked done, and it helped' : 'marked done'}
                      </Badge>
                    )}
                    <div className="text-muted-foreground">{s.detail}</div>
                    <div className="mt-1 flex gap-1">
                      {s.status !== 'done' && (
                        <Button size="sm" variant="ghost" disabled={suggest.isPending} onClick={() => suggest.mutate({ key: s.key, status: 'done' })}>
                          I did this
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" disabled={suggest.isPending} onClick={() => suggest.mutate({ key: s.key, status: 'dismissed' })}>
                        Stop suggesting this
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
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
  if (lesson.status === 'retired') return <Badge variant="outline" className="ml-2">retired: {lesson.retiredReason}</Badge>;
  if (lesson.verdict === 'unproven') return <Badge variant="outline" className="ml-2">{n === 0 ? 'not tested yet' : `testing: ${back} of ${n} sessions`}</Badge>;
  const label = lesson.verdict === 'working' ? 'working' : lesson.verdict === 'mixed' ? 'mixed' : 'not working';
  return (
    <Badge variant="outline" className="ml-2">
      {label}: came back in {back} of {n}
    </Badge>
  );
}
