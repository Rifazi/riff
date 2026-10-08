'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, CheckCircle2, ChevronDown, Circle, CircleDot, GitFork, Loader2, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { api } from '@/lib/dev-sessions/api';
import type { RoadmapPart, SessionRecord, SplitProposal, SplitRoadmap } from '@/lib/dev-sessions/types';
import { sessionHref, STAGE_LABEL } from '@/lib/dev-sessions/stage';
import { Notice } from './PageShell';

/** The requirements agent's pending propose_split, for the human to accept or turn down. */
export function SplitProposalCard({
  proposal,
  agentName,
  busy,
  disabled,
  onAccept,
  onDismiss,
}: {
  proposal: SplitProposal;
  agentName: string;
  busy: 'accept' | 'dismiss' | null;
  disabled: boolean;
  onAccept: () => void;
  onDismiss: () => void;
}) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  return (
    <div className="rounded-md border border-primary/30 bg-primary/5 p-3 space-y-3">
      <div className="flex items-start gap-2">
        <GitFork className="w-4 h-4 mt-0.5 text-primary flex-shrink-0" />
        <div>
          <div className="text-sm font-semibold text-foreground">
            {agentName} suggests splitting this into {proposal.parts.length} sessions
          </div>
          <p className="text-sm text-muted-foreground mt-0.5">{proposal.rationale}</p>
        </div>
      </div>

      <ol className="space-y-1.5">
        {proposal.parts.map((part, i) => (
          <li key={part.sessionKey} className="rounded border border-border bg-card">
            <button
              type="button"
              onClick={() => setOpenIndex(openIndex === i ? null : i)}
              className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left"
            >
              <span className="text-xs font-medium text-muted-foreground w-4">{i + 1}.</span>
              <span className="flex-1 min-w-0">
                <span className="text-sm font-medium text-foreground">{part.title}</span>
                <span className="ml-2 font-mono text-[11px] text-muted-foreground">{part.sessionKey}</span>
                {part.dependsOn.length > 0 && (
                  <span className="ml-2 text-[11px] text-muted-foreground">
                    after {part.dependsOn.map((d) => d + 1).join(', ')}
                  </span>
                )}
                {part.outcome && <span className="block text-xs text-muted-foreground">{part.outcome}</span>}
              </span>
              <ChevronDown
                className={`w-3.5 h-3.5 text-muted-foreground transition-transform ${openIndex === i ? 'rotate-180' : ''}`}
              />
            </button>
            {openIndex === i && (
              <div className="px-3 pb-2.5 pt-1 text-xs text-foreground whitespace-pre-wrap border-t border-border">
                {part.brief}
              </div>
            )}
          </li>
        ))}
      </ol>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={disabled || busy !== null} onClick={onAccept}>
          {busy === 'accept' ? <Loader2 className="animate-spin" /> : <GitFork />}
          Split into {proposal.parts.length} sessions
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="bg-card"
          disabled={disabled || busy !== null}
          onClick={onDismiss}
        >
          {busy === 'dismiss' && <Loader2 className="animate-spin" />}
          Keep as one
        </Button>
        <span className="text-xs text-muted-foreground">
          Built in this order, each through its own requirements → plan → code → QA. This session keeps the roadmap.
        </span>
      </div>
    </div>
  );
}

function useRoadmap(session: SessionRecord) {
  const related = session.splitInto.length > 0 || Boolean(session.splitFrom);
  return useQuery({
    // Keyed on the stage so the page refetches as this session moves on.
    queryKey: ['roadmap', session.id, session.stage],
    queryFn: () => api.getRoadmap(session.id),
    enabled: related,
  });
}

const STATUS: Record<RoadmapPart['status'], { label: string; variant: 'success' | 'info' | 'secondary' | 'destructive' }> = {
  shipped: { label: 'Shipped', variant: 'success' },
  'in-progress': { label: 'In progress', variant: 'info' },
  'not-started': { label: 'Not started', variant: 'secondary' },
  dropped: { label: 'Dropped', variant: 'destructive' },
  missing: { label: 'Deleted', variant: 'destructive' },
};

function StatusIcon({ status }: { status: RoadmapPart['status'] }) {
  const cls = 'w-4 h-4 flex-shrink-0';
  if (status === 'shipped') return <CheckCircle2 className={`${cls} text-success`} />;
  if (status === 'in-progress') return <CircleDot className={`${cls} text-primary`} />;
  if (status === 'not-started') return <Circle className={`${cls} text-muted-foreground`} />;
  return <XCircle className={`${cls} text-destructive`} />;
}

function partStageLabel(part: RoadmapPart): string {
  if (part.status === 'in-progress' && part.stage) return STAGE_LABEL[part.stage] ?? part.stage;
  return STATUS[part.status].label;
}

function deliveryText(part: RoadmapPart): string | null {
  const d = part.delivery;
  if (!d) return null;
  if (d.kind === 'merged') return `Merged into ${d.target}`;
  return d.kind === 'merge_request' ? `Merge request into ${d.target}` : `Pushed, merge into ${d.target} by hand`;
}

function RoadmapList({ roadmap, currentId }: { roadmap: SplitRoadmap; currentId: string }) {
  return (
    <ol className="space-y-1.5">
      {roadmap.parts.map((part) => {
        const waiting = part.status !== 'shipped' && part.blockedBy.length > 0;
        const delivery = deliveryText(part);
        const isNext = part.index === roadmap.nextIndex;
        const row = (
          <div className="flex items-start gap-2.5 px-2.5 py-2">
            <StatusIcon status={part.status} />
            <div className="flex-1 min-w-0 -mt-0.5">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="text-xs text-muted-foreground">{part.index + 1}.</span>
                <span className="text-sm font-medium text-foreground">{part.title}</span>
                <span className="font-mono text-[11px] text-muted-foreground">{part.sessionKey}</span>
                {part.sessionId === currentId && <Badge variant="outline">This session</Badge>}
                {isNext && part.sessionId !== currentId && <Badge variant="info">Next</Badge>}
              </div>
              {part.outcome && <div className="text-xs text-muted-foreground mt-0.5">{part.outcome}</div>}
              {(waiting || delivery) && (
                <div className="text-[11px] text-muted-foreground mt-0.5">
                  {waiting && `Waiting on ${part.blockedBy.map((d) => roadmap.parts[d].title).join(', ')}`}
                  {delivery &&
                    (part.delivery?.url ? (
                      <a href={part.delivery.url} target="_blank" rel="noreferrer" className="underline">
                        {delivery}
                      </a>
                    ) : (
                      delivery
                    ))}
                </div>
              )}
            </div>
            <Badge variant={part.status === 'in-progress' ? 'info' : STATUS[part.status].variant}>{partStageLabel(part)}</Badge>
          </div>
        );
        return (
          <li key={part.sessionId} className="rounded border border-border bg-card">
            {part.status === 'missing' || part.sessionId === currentId ? (
              row
            ) : (
              <Link href={sessionHref(part.sessionId)} className="block hover:bg-muted/50 rounded">
                {row}
              </Link>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function ContinueButton({ roadmap, label = 'Continue' }: { roadmap: SplitRoadmap; label?: string }) {
  const next = roadmap.nextIndex === null ? null : roadmap.parts[roadmap.nextIndex];
  if (!next) return null;
  return (
    <Button size="sm" asChild>
      <Link href={sessionHref(next.sessionId)}>
        {label}: {next.title}
        <ArrowRight />
      </Link>
    </Button>
  );
}

/**
 * The roadmap of a split feature, on the session that was split: build
 * order, where each part stands, what shipped, and a button to the part to
 * work on next.
 */
function ParentRoadmap({ session, roadmap }: { session: SessionRecord; roadmap: SplitRoadmap }) {
  const total = roadmap.parts.length;
  const done = roadmap.shipped === total;
  const stuck = !done && roadmap.nextIndex === null;
  return (
    <div className="rounded-md border border-border bg-muted/30 p-3 space-y-3">
      <div className="flex items-start gap-2">
        <GitFork className="w-4 h-4 mt-0.5 text-primary flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-foreground">
            Split into {total} parts · {roadmap.shipped} of {total} shipped
          </div>
          {roadmap.parent.rationale && <p className="text-sm text-muted-foreground mt-0.5">{roadmap.parent.rationale}</p>}
        </div>
      </div>
      <Progress value={(roadmap.shipped / total) * 100} className="h-1.5" />
      <RoadmapList roadmap={roadmap} currentId={session.id} />
      {done ? (
        <Notice tone="green">Every part has shipped.</Notice>
      ) : stuck ? (
        <Notice tone="amber">
          Every remaining part is waiting on one that was dropped or deleted. Reopen it from the sessions list, or open a
          waiting part and approve its plan anyway.
        </Notice>
      ) : (
        <ContinueButton roadmap={roadmap} />
      )}
    </div>
  );
}

/** On a part of a split feature: where it sits, what it's waiting on, and what comes after it. */
export function SplitPartStrip({ session }: { session: SessionRecord }) {
  const { data: roadmap } = useRoadmap(session);
  const [open, setOpen] = useState(false);
  if (!session.splitFrom || !roadmap) return null;
  const self = roadmap.parts.find((p) => p.sessionId === session.id);
  if (!self) return null;
  const waiting = self.status !== 'shipped' ? self.blockedBy.map((d) => roadmap.parts[d]) : [];

  return (
    <div className="rounded-md border border-border bg-card px-3 py-2 text-sm space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <GitFork className="w-4 h-4 text-primary flex-shrink-0" />
        <span>
          Part {self.index + 1} of {roadmap.parts.length} of{' '}
          <Link href={sessionHref(roadmap.parent.sessionId)} className="font-medium hover:underline">
            {roadmap.parent.title}
          </Link>
        </span>
        <span className="text-muted-foreground">
          {roadmap.shipped} of {roadmap.parts.length} shipped
        </span>
        {waiting.length > 0 && (
          <Badge variant="warning" title="Its code isn't on the base branch yet, so wait before coding this part.">
            Waiting on {waiting.map((p) => p.title).join(', ')}
          </Badge>
        )}
        <span className="flex-1" />
        {self.status === 'shipped' && <ContinueButton roadmap={roadmap} label="Next part" />}
        <Button size="sm" variant="ghost" onClick={() => setOpen(!open)}>
          Roadmap
          <ChevronDown className={`transition-transform ${open ? 'rotate-180' : ''}`} />
        </Button>
      </div>
      {open && <RoadmapList roadmap={roadmap} currentId={session.id} />}
    </div>
  );
}

/** The roadmap on a split session's Requirements tab. */
export function SplitLinks({ session }: { session: SessionRecord }) {
  const { data: roadmap } = useRoadmap(session);
  if (session.splitInto.length === 0 || !roadmap) return null;
  return <ParentRoadmap session={session} roadmap={roadmap} />;
}

/** For the Plan tab: the parts this one is still waiting on, if it's a part of a split. */
export function useUnshippedDependencies(session: SessionRecord): RoadmapPart[] {
  const { data: roadmap } = useRoadmap(session);
  const self = roadmap?.parts.find((p) => p.sessionId === session.id);
  return self && roadmap ? self.blockedBy.map((d) => roadmap.parts[d]) : [];
}
