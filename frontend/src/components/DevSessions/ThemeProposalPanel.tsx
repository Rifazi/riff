'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Paintbrush } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { api } from '@/lib/dev-sessions/api';
import type { SessionRecord, ThemeApplyResult, ThemeDraft } from '@/lib/dev-sessions/types';
import { ErrorText, Notice } from './PageShell';
import { ThemeStudio } from './themes/ThemeStudio';
import { sameTheme } from './themes/theme-utils';

/**
 * The requirements agent's propose_theme suggestion: a notice in the
 * document pane plus the theme picker, which opens by itself when a new
 * proposal arrives. Only the human applies it, as proposed or as edited.
 */
export function ThemeProposalPanel({
  session,
  agentName,
  disabled,
  onApplied,
  onDismissed,
}: {
  session: SessionRecord;
  agentName: string;
  disabled: boolean;
  onApplied: (result: ThemeApplyResult, edited: boolean) => void;
  onDismissed: () => void;
}) {
  const proposal = session.themeProposal;
  const queryClient = useQueryClient();
  const { data: apps } = useQuery({ queryKey: ['apps'], queryFn: api.listApps });
  const { data: themeState } = useQuery({
    queryKey: ['app-theme', session.appId],
    queryFn: () => api.getAppTheme(session.appId),
    enabled: Boolean(proposal),
  });
  const appName = apps?.find((a) => a.id === session.appId)?.name ?? 'this app';

  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<ThemeDraft | null>(null);
  // Each new proposal opens the picker once, starting from what the agent suggested.
  useEffect(() => {
    if (!proposal) return;
    setDraft({ theme: proposal.theme, basedOn: proposal.basedOn });
    setOpen(true);
  }, [proposal?.proposedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const applyMutation = useMutation({
    mutationFn: () => api.applyThemeProposal(session.id, draft!),
    onSuccess: (result) => {
      setOpen(false);
      queryClient.invalidateQueries({ queryKey: ['app-theme', session.appId] });
      queryClient.invalidateQueries({ queryKey: ['apps'] });
      onApplied(result, Boolean(proposal && draft && !sameTheme(proposal.theme, draft.theme)));
    },
  });
  const dismissMutation = useMutation({
    mutationFn: () => api.dismissThemeProposal(session.id),
    onSuccess: () => {
      setOpen(false);
      onDismissed();
    },
  });

  if (!proposal) return null;
  const busy = applyMutation.isPending || dismissMutation.isPending;
  const error = (applyMutation.error ?? dismissMutation.error) as Error | null;

  return (
    <>
      <Notice tone="blue">
        <div className="space-y-2">
          <div>
            <span className="font-medium">{agentName} suggested a theme: {proposal.theme.name}.</span> {proposal.summary}
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="blue" disabled={disabled} onClick={() => setOpen(true)}>
              <Paintbrush />
              Open theme picker
            </Button>
            <Button size="sm" variant="outline" disabled={disabled || busy} onClick={() => dismissMutation.mutate()}>
              Dismiss
            </Button>
          </div>
        </div>
      </Notice>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-6xl w-[95vw] max-h-[92vh] overflow-y-auto custom-scrollbar bg-gray-50">
          <DialogHeader>
            <DialogTitle>Theme for {appName}</DialogTitle>
            <DialogDescription>
              {agentName}: {proposal.summary} Adjust anything, then apply. It&apos;s saved to <code>theme/theme.json</code> and
              committed on the base branch.
            </DialogDescription>
          </DialogHeader>
          <ThemeStudio value={draft} onChange={setDraft} current={themeState?.current ?? null} appName={appName} />
          <ErrorText>{error?.message ?? null}</ErrorText>
          <DialogFooter className="gap-2">
            <Button variant="outline" disabled={busy} onClick={() => dismissMutation.mutate()}>
              Dismiss suggestion
            </Button>
            <Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>
              Decide later
            </Button>
            <Button variant="blue" disabled={!draft || busy || disabled} onClick={() => applyMutation.mutate()}>
              <Paintbrush />
              {applyMutation.isPending ? 'Applying…' : `Apply ${draft?.theme.name ?? 'theme'}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
