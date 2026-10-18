'use client';

import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { QRCodeSVG } from 'qrcode.react';
import { toast } from 'sonner';
import { CheckCircle2, Copy, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { ExternalAnchor } from '@/components/DevSessions/ExternalAnchor';

type Network = 'tailscale' | 'lan';

interface RemoteInfo {
  enabled: boolean;
  port: number;
  token: string;
  network: Network;
  tailscale: 'not_installed' | 'not_connected' | 'ready';
  lan_available: boolean;
  hosts: string[];
  error: string | null;
}

const TAILSCALE_DOWNLOAD = 'https://tailscale.com/download';

/** Settings → Phone: pair the Riff phone app, which shows these same views and drives this Mac. */
export function PhoneSettings() {
  const [info, setInfo] = useState<RemoteInfo | null>(null);

  const refresh = useCallback(() => invoke<RemoteInfo>('remote_info').then(setInfo).catch(() => {}), []);
  // Tailscale signing in, Wi-Fi coming back and the server starting all happen on their own, so just watch.
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  }, [refresh]);

  const fail = (title: string) => (e: unknown) =>
    toast.error(title, { description: e instanceof Error ? e.message : String(e) });

  if (!info) return <div className="py-10 text-center text-sm text-muted-foreground">Loading…</div>;

  const links = info.hosts.map((h) => `http://${h}:${info.port}/#token=${info.token}`);
  const waiting = info.enabled && links.length === 0;

  return (
    <div className="mt-6 space-y-4">
      <Card className="space-y-4 p-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h3 className="font-medium">Control Riff from your phone</h3>
            <p className="text-sm text-muted-foreground">
              The phone app shows these same screens and sends everything to this Mac. Recording, transcripts and
              agents stay here, so the Riff window must stay open (it can be hidden).
            </p>
          </div>
          <Switch
            checked={info.enabled}
            onCheckedChange={(enabled) =>
              invoke('remote_set_enabled', { enabled }).then(refresh).catch(fail('Could not change phone access'))
            }
          />
        </div>
      </Card>

      {info.enabled && (
        <Card className="space-y-3 p-6">
          <h3 className="font-medium">How your phone reaches this Mac</h3>
          <NetworkChoice
            selected={info.network === 'tailscale'}
            onSelect={() => invoke('remote_set_network', { network: 'tailscale' }).then(refresh).catch(fail('Could not switch network'))}
            title="Tailscale (recommended)"
            detail="Works from anywhere. Nothing is exposed to the internet or to other devices on your Wi-Fi."
            status={
              info.tailscale === 'ready' ? (
                <Ready>Connected</Ready>
              ) : info.tailscale === 'not_installed' ? (
                <span className="text-sm">
                  Tailscale isn't installed on this Mac.{' '}
                  <ExternalAnchor href={TAILSCALE_DOWNLOAD} className="text-primary underline">
                    Get Tailscale
                  </ExternalAnchor>
                  , sign in, and install it on your phone too. Riff notices automatically.
                </span>
              ) : (
                <span className="text-sm">Tailscale is installed but not connected. Open it from the menu bar and sign in.</span>
              )
            }
          />
          <NetworkChoice
            selected={info.network === 'lan'}
            onSelect={() => invoke('remote_set_network', { network: 'lan' }).then(refresh).catch(fail('Could not switch network'))}
            title="This Wi-Fi network only"
            detail="No extra app, but it stops working away from home, and other devices on this network can reach the pairing page (they can't do anything without the link's secret)."
            status={info.lan_available ? <Ready>Network found</Ready> : <span className="text-sm">This Mac isn't on a network.</span>}
          />
        </Card>
      )}

      {waiting && (
        <Card className="flex items-center gap-3 p-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {info.error ?? 'Starting…'}
        </Card>
      )}

      {info.enabled && !waiting && info.error && <Card className="p-6 text-sm text-destructive">{info.error}</Card>}

      {links.map((link) => (
        <Card key={link} className="space-y-4 p-6">
          <h3 className="font-medium">Pair your phone</h3>
          <div className="flex flex-col gap-5 sm:flex-row">
            <div className="shrink-0 self-start rounded-lg bg-white p-3">
              <QRCodeSVG value={link} size={176} />
            </div>
            <ol className="list-decimal space-y-2 pl-5 text-sm text-muted-foreground">
              <li>
                {info.network === 'tailscale'
                  ? 'Make sure Tailscale is on, and signed in to the same account, on your phone.'
                  : 'Make sure your phone is on the same Wi-Fi as this Mac.'}
              </li>
              <li>Scan this code with the phone's camera and open it in Safari.</li>
              <li>Tap Share → Add to Home Screen to keep Riff on your phone.</li>
              <li>Anyone with this code can control Riff, so don't share it. Make a new one below if it leaks.</li>
            </ol>
          </div>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 text-xs">{link}</code>
            <Button
              size="sm"
              variant="outline"
              onClick={() => navigator.clipboard.writeText(link).then(() => toast.success('Link copied'))}
            >
              <Copy className="mr-1 h-4 w-4" /> Copy
            </Button>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              invoke('remote_rotate_token')
                .then(() => {
                  toast.success('New pairing code made. Phones paired before need the new one.');
                  return refresh();
                })
                .catch(fail('Could not make a new code'))
            }
          >
            <RefreshCw className="mr-1 h-4 w-4" /> Make a new pairing code
          </Button>
        </Card>
      ))}
    </div>
  );
}

function Ready({ children }: { children: React.ReactNode }) {
  return (
    <span className="flex items-center gap-1 text-sm text-success">
      <CheckCircle2 className="h-4 w-4" /> {children}
    </span>
  );
}

function NetworkChoice(props: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  detail: string;
  status: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={props.onSelect}
      className={`w-full rounded-lg border p-4 text-left transition-colors ${
        props.selected ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50'
      }`}
    >
      <div className="flex items-center gap-2">
        <span
          className={`h-4 w-4 rounded-full border ${props.selected ? 'border-primary bg-primary' : 'border-muted-foreground'}`}
        />
        <span className="font-medium">{props.title}</span>
      </div>
      <p className="mt-1 pl-6 text-sm text-muted-foreground">{props.detail}</p>
      <div className="mt-2 pl-6">{props.status}</div>
    </button>
  );
}
