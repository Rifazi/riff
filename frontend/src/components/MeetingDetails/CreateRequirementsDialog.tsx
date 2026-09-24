"use client";

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Loader2, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { api } from '@/lib/dev-sessions/api';
import { AGENT_PERSONAS } from '@/lib/dev-sessions/agents';
import { buildMeetingSource } from '@/lib/dev-sessions/meeting';
import { sessionHref, STAGE_LABEL, stageGroupFor } from '@/lib/dev-sessions/stage';
import { useAgentServerHealth } from '@/components/DevSessions/AgentServerBanner';
import { AppPicker } from '@/components/DevSessions/AppPicker';
import Analytics from '@/lib/analytics';

export interface MeetingRequirementsContext {
  meetingId: string;
  meetingTitle: string;
  meetingCreatedAt?: string | null;
  getSummaryMarkdown?: () => Promise<string | null>;
}

export function useMeetingSessions(meetingId: string | undefined) {
  const { data: healthy } = useAgentServerHealth();
  return useQuery({
    queryKey: ['sessions', { meetingId }],
    queryFn: () => api.listSessions({ meetingId }),
    enabled: Boolean(meetingId) && healthy === true,
  });
}

export function CreateRequirementsDialog({
  open,
  onOpenChange,
  context,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  context: MeetingRequirementsContext;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data: healthy } = useAgentServerHealth();
  const { data: existing } = useMeetingSessions(context.meetingId);

  const [appId, setAppId] = useState('');
  const [title, setTitle] = useState(context.meetingTitle);
  const [sessionKey, setSessionKey] = useState('');
  const [includeSummary, setIncludeSummary] = useState(true);
  const [summaryAvailable, setSummaryAvailable] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTitle(context.meetingTitle);
    setSessionKey('');
    context
      .getSummaryMarkdown?.()
      .then((md) => setSummaryAvailable(Boolean(md?.trim())))
      .catch(() => setSummaryAvailable(false));
  }, [open, context]);

  const createMutation = useMutation({
    mutationFn: async () => {
      const summary = includeSummary && summaryAvailable ? await context.getSummaryMarkdown?.() : null;
      const source = await buildMeetingSource({
        meetingId: context.meetingId,
        meetingTitle: context.meetingTitle,
        meetingCreatedAt: context.meetingCreatedAt,
        summaryMarkdown: summary,
      });
      if (!source.transcript.trim()) throw new Error('This meeting has no transcript yet.');
      return api.createSession({ title: title.trim(), sessionKey: sessionKey.trim() || undefined, appId, source });
    },
    onSuccess: (session) => {
      Analytics.trackButtonClick('create_requirements_from_meeting', 'meeting_details');
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
            Create requirements from this meeting
          </DialogTitle>
          <DialogDescription>
            {AGENT_PERSONAS.requirements.name}, the requirements agent, reads the full transcript, asks you about anything
            unclear, and drafts a requirements document. After you approve it, the session continues to planning, coding
            and QA.
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
                  <span className="font-medium text-gray-900">Include the AI summary</span>
                  <span className="block text-xs text-gray-500">Sent alongside the transcript as extra context.</span>
                </span>
                <Switch checked={includeSummary} onCheckedChange={setIncludeSummary} />
              </label>
            )}
            {existing && existing.length > 0 && (
              <div className="rounded-md bg-gray-50 border border-gray-200 px-3 py-2">
                <div className="text-xs font-medium text-gray-500 mb-1">Already started from this meeting</div>
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
            {createMutation.isPending ? 'Creating…' : 'Start requirements'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
