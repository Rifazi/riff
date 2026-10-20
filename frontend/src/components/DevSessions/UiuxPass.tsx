'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Paintbrush } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { api } from '@/lib/dev-sessions/api';
import { sessionHref } from '@/lib/dev-sessions/stage';
import type { AppConfig } from '@/lib/dev-sessions/types';
import { ErrorText } from './PageShell';

function StartDialog({ app, open, onClose }: { app: AppConfig; open: boolean; onClose: () => void }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');
  const [focus, setFocus] = useState('');

  const start = useMutation({
    mutationFn: () => api.startUiuxPass(app.id, { title: title.trim() || undefined, focus: focus.trim() || undefined }),
    onSuccess: (session) => {
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
      router.push(sessionHref(session.id, 'requirements'));
    },
  });

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>UI/UX pass on {app.name}</DialogTitle>
          <DialogDescription>
            A separate session. The UI/UX lead opens the app in a browser, judges it, writes the requirements and a plan, and starts the coding
            agent on its own branch. QA and shipping work as for any session.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="uiux-title">Name</Label>
            <Input id="uiux-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="UI/UX pass" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="uiux-focus">What to look at (optional)</Label>
            <Textarea
              id="uiux-focus"
              value={focus}
              onChange={(e) => setFocus(e.target.value)}
              rows={4}
              placeholder="Screens, flows or a concern, e.g. the checkout flow, or mobile layouts. Blank audits the whole UI."
            />
          </div>
          <ErrorText>{start.error ? (start.error as Error).message : null}</ErrorText>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={start.isPending} onClick={() => start.mutate()}>
            {start.isPending ? 'Starting…' : 'Start pass'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The app card header's UI/UX pass button: turns the pass on for the app the first time, then opens the dialog that starts one. */
export function UiuxPassRow({ app }: { app: AppConfig }) {
  const queryClient = useQueryClient();
  const [starting, setStarting] = useState(false);
  const enable = useMutation({
    mutationFn: () => api.updateApp(app.id, { uiuxPass: true }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['apps'] });
      setStarting(true);
    },
  });

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        disabled={enable.isPending}
        onClick={() => (app.uiuxPass ? setStarting(true) : enable.mutate())}
      >
        <Paintbrush />
        Start a UI/UX pass
      </Button>
      <ErrorText>{enable.error ? (enable.error as Error).message : null}</ErrorText>
      {starting && <StartDialog app={app} open onClose={() => setStarting(false)} />}
    </>
  );
}
