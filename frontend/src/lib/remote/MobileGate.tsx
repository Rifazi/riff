'use client';

import { Button } from '@/components/ui/button';
import { getToken } from './transport';

/** Shown on the phone instead of the app when it isn't paired, can't reach the Mac, or the Mac hasn't finished setup. */
export function MobileGate({ reason }: { reason: 'setup' | 'unreachable' }) {
  const paired = !!getToken();
  const text = !paired
    ? {
        title: 'Pair with your Mac',
        body: 'On your Mac open Riff → Settings → Phone, switch it on, and open the pairing link here in Safari.',
      }
    : reason === 'setup'
      ? { title: 'Finish setup on your Mac', body: 'Riff on your Mac hasn’t completed its first-run setup yet.' }
      : {
          title: 'Can’t reach your Mac',
          body: 'Check that Tailscale is connected on both devices, and that Riff is running on your Mac with its window open.',
        };
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-background px-6 pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] text-center">
      <h1 className="text-2xl font-bold text-foreground">{text.title}</h1>
      <p className="max-w-sm text-sm text-muted-foreground">{text.body}</p>
      {paired && <Button onClick={() => window.location.reload()}>Try again</Button>}
    </div>
  );
}
