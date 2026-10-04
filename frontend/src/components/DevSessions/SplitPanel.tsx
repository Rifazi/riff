'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, GitFork, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { api } from '@/lib/dev-sessions/api';
import type { SessionRecord, SplitProposal } from '@/lib/dev-sessions/types';
import { sessionHref, STAGE_LABEL, stageGroupFor } from '@/lib/dev-sessions/stage';
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
        <span className="text-xs text-muted-foreground">Each part gets its own requirements → plan → code → QA.</span>
      </div>
    </div>
  );
}

function SessionLink({ session }: { session: SessionRecord }) {
  return (
    <Link
      href={sessionHref(session.id, stageGroupFor(session))}
      className="inline-flex items-center gap-1.5 hover:underline"
    >
      <span className="font-medium">{session.title}</span>
      <span className="font-mono text-[11px] opacity-70">{session.sessionKey}</span>
    </Link>
  );
}

/** Where this session sits in a split: the children of a split parent, or a child's parent and dependencies. */
export function SplitLinks({ session }: { session: SessionRecord }) {
  const related = session.splitInto.length > 0 || session.splitFrom;
  const { data: sessions } = useQuery({
    queryKey: ['sessions'],
    queryFn: () => api.listSessions(),
    enabled: Boolean(related),
  });
  if (!related) return null;
  const byId = new Map((sessions ?? []).map((s) => [s.id, s]));

  if (session.splitInto.length > 0) {
    return (
      <Notice tone="blue">
        <div className="font-medium mb-1">Split into {session.splitInto.length} sessions — continue in those:</div>
        <ol className="space-y-1 list-decimal list-inside">
          {session.splitInto.map((id) => {
            const child = byId.get(id);
            return (
              <li key={id}>
                {child ? (
                  <>
                    <SessionLink session={child} />{' '}
                    <Badge variant="secondary">{STAGE_LABEL[child.stage] ?? child.stage}</Badge>
                  </>
                ) : (
                  <span className="text-muted-foreground">(deleted session)</span>
                )}
              </li>
            );
          })}
        </ol>
      </Notice>
    );
  }

  const origin = session.splitFrom!;
  const parent = byId.get(origin.sessionId);
  const deps = origin.dependsOnSessionIds.map((id) => byId.get(id)).filter((s): s is SessionRecord => Boolean(s));
  return (
    <Notice>
      Part of {parent ? <SessionLink session={parent} /> : <span className="font-medium">{origin.title}</span>}
      {deps.length > 0 && (
        <>
          {' '}
          · builds on{' '}
          {deps.map((dep, i) => (
            <span key={dep.id}>
              {i > 0 && ', '}
              <SessionLink session={dep} /> <Badge variant="secondary">{STAGE_LABEL[dep.stage] ?? dep.stage}</Badge>
            </span>
          ))}
        </>
      )}
    </Notice>
  );
}
