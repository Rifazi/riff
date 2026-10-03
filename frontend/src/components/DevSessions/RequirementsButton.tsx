"use client";

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, ClipboardList, Loader2, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { api } from '@/lib/dev-sessions/api';
import { AGENT_PERSONAS } from '@/lib/dev-sessions/agents';
import { buildMeetingSource } from '@/lib/dev-sessions/meeting';
import type { MeetingSourceInput } from '@/lib/dev-sessions/types';
import { sessionHref, STAGE_LABEL, stageGroupFor } from '@/lib/dev-sessions/stage';
import { journalApi } from '@/lib/journal/api';
import { useAgentServerHealth } from '@/components/DevSessions/AgentServerBanner';
import { AppPicker } from '@/components/DevSessions/AppPicker';
import Analytics from '@/lib/analytics';

/** What a Dev Session can start from. */
export type RequirementsSource = {
  kind: 'meeting' | 'journal';
  /** Meeting id, or journal id (sent to the server as `meetingId`). */
  id: string;
  title: string;
  meetingCreatedAt?: string | null;
  /** The meeting's AI summary, or the journal's overview; read when the session is created. */
  getSummaryMarkdown: () => Promise<string | null>;
};

async function buildSource(source: RequirementsSource, summary: string | null): Promise<MeetingSourceInput> {
  if (source.kind === 'meeting') {
    return buildMeetingSource({
      meetingId: source.id,
      meetingTitle: source.title,
      meetingCreatedAt: source.meetingCreatedAt,
      summaryMarkdown: summary,
    });
  }
  const brief = await journalApi.requirementsBrief(source.id);
  return {
    kind: 'journal',
    meetingId: source.id,
    meetingTitle: source.title,
    meetingDate: brief.covers,
    transcript: brief.notes_markdown,
    summary,
  };
}

function useSourceSessions(id: string) {
  const { data: healthy } = useAgentServerHealth();
  return useQuery({
    queryKey: ['sessions', { meetingId: id }],
    queryFn: () => api.listSessions({ meetingId: id }),
    enabled: Boolean(id) && healthy === true,
  });
}

/**
 * The one way into Dev Sessions from a meeting or a journal: shows where the
 * latest session is, and opens a dialog to continue one or start another.
 */
export function RequirementsButton({ source, disabled }: { source: RequirementsSource; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const { data: sessions } = useSourceSessions(source.id);
  const latest = sessions?.[0];

  return (
    <>
      <Button
        size="sm"
        className="bg-purple-600 text-white hover:bg-purple-700"
        disabled={disabled}
        onClick={() => setOpen(true)}
        title={disabled ? `This ${source.kind} has nothing to work from yet` : `Turn this ${source.kind} into requirements, then plan, code and QA it`}
      >
        <ClipboardList />
        {latest ? `Dev session: ${STAGE_LABEL[latest.stage] ?? latest.stage}` : 'Create requirements'}
        {sessions && sessions.length > 1 && (
          <span className="rounded-full bg-white/25 px-1.5 text-[10px] leading-4">{sessions.length}</span>
        )}
      </Button>
      <RequirementsDialog open={open} onOpenChange={setOpen} source={source} />
    </>
  );
}

function RequirementsDialog({
  open,
  onOpenChange,
  source,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  source: RequirementsSource;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data: healthy } = useAgentServerHealth();
  const { data: existing } = useSourceSessions(source.id);

  const [appId, setAppId] = useState('');
  const [title, setTitle] = useState(source.title);
  const [sessionKey, setSessionKey] = useState('');
  const [includeSummary, setIncludeSummary] = useState(true);
  const [summaryAvailable, setSummaryAvailable] = useState(false);
  const isJournal = source.kind === 'journal';

  useEffect(() => {
    if (!open) return;
    setTitle(source.title);
    setSessionKey('');
    source
      .getSummaryMarkdown()
      .then((md) => setSummaryAvailable(Boolean(md?.trim())))
      .catch(() => setSummaryAvailable(false));
  }, [open, source]);

  const createMutation = useMutation({
    mutationFn: async () => {
      const summary = includeSummary && summaryAvailable ? ((await source.getSummaryMarkdown())?.trim() || null) : null;
      const input = await buildSource(source, summary);
      if (!input.transcript.trim()) throw new Error(`This ${source.kind} has nothing to work from yet.`);
      return api.createSession({ title: title.trim(), sessionKey: sessionKey.trim() || undefined, appId, source: input });
    },
    onSuccess: (session) => {
      Analytics.trackButtonClick(`create_requirements_from_${source.kind}`, isJournal ? 'journal' : 'meeting_details');
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
      onOpenChange(false);
      router.push(sessionHref(session.id, 'requirements'));
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-purple-600" />
            Create requirements from this {source.kind}
          </DialogTitle>
          <DialogDescription>
            {AGENT_PERSONAS.requirements.name}, the requirements agent, reads{' '}
            {isJournal ? 'every note in the journal and the transcript behind it' : 'the full transcript'}, asks you about
            anything unclear, and drafts a requirements document. After you approve it, the session continues to
            planning, coding and QA.
          </DialogDescription>
        </DialogHeader>

        {healthy === false ? (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            The agent server isn't running yet.{' '}
            <Link href="/dev-sessions" className="font-medium underline" onClick={() => onOpenChange(false)}>
              Open Dev Sessions
            </Link>{' '}
            to see its status.
          </div>
        ) : (
          <div className="space-y-4 py-1">
            {existing && existing.length > 0 && (
              <div className="rounded-md bg-gray-50 border border-gray-200 px-3 py-2">
                <div className="text-xs font-medium text-gray-500 mb-1">Continue a session from this {source.kind}</div>
                <ul className="space-y-1">
                  {existing.map((s) => (
                    <li key={s.id}>
                      <Link
                        href={sessionHref(s.id, stageGroupFor(s))}
                        onClick={() => onOpenChange(false)}
                        className="flex items-center justify-between gap-2 text-sm text-blue-600 hover:underline"
                      >
                        <span className="truncate">
                          {s.title} <span className="text-gray-400">· {s.appName}</span>
                        </span>
                        <span className="text-xs text-gray-500 flex-shrink-0">{STAGE_LABEL[s.stage] ?? s.stage}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="space-y-1.5">
              <Label>App</Label>
              <AppPicker value={appId} onChange={setAppId} enabled={open && healthy === true} />
            </div>
            <div className="space-y-1.5">
              <Label>Feature title</Label>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What is being built?" />
            </div>
            <div className="space-y-1.5">
              <Label>
                Ticket ID <span className="text-gray-400 font-normal">(optional)</span>
              </Label>
              <Input value={sessionKey} onChange={(e) => setSessionKey(e.target.value)} placeholder="e.g. API-1234" />
            </div>
            {summaryAvailable && (
              <label className="flex items-center justify-between gap-3 rounded-md border border-gray-200 px-3 py-2 cursor-pointer">
                <span className="text-sm">
                  <span className="font-medium text-gray-900">{isJournal ? 'Include the journal overview' : 'Include the AI summary'}</span>
                  <span className="block text-xs text-gray-500">
                    Sent alongside the {isJournal ? 'notes' : 'transcript'} as extra context.
                  </span>
                </span>
                <Switch checked={includeSummary} onCheckedChange={setIncludeSummary} />
              </label>
            )}
            {createMutation.isError && <div className="text-sm text-red-600">{(createMutation.error as Error).message}</div>}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="blue"
            onClick={() => createMutation.mutate()}
            disabled={healthy !== true || !appId || !title.trim() || createMutation.isPending}
          >
            {createMutation.isPending ? <Loader2 className="animate-spin" /> : <ArrowRight />}
            {createMutation.isPending ? 'Creating…' : existing?.length ? 'Start new session' : 'Start requirements'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
