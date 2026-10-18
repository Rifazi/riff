'use client';

import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { IS_MOBILE } from './is-mobile';
import { adoptTokenFromHash, getToken } from './transport';

/**
 * Desktop: runs the commands the phone asks for and forwards the events it
 * subscribed to (the Rust side can't call Tauri commands by name, see
 * src-tauri/src/remote/mod.rs). Phone: adds the pairing token to agent-server
 * requests, which go through the Mac's `/agent` proxy.
 */
function DesktopRelay() {
  useEffect(() => {
    const unlisteners: Promise<UnlistenFn>[] = [];
    const subscribed = new Set<string>();

    unlisteners.push(
      listen<{ id: string; cmd: string; args: Record<string, unknown> | null }>('remote-invoke', async ({ payload }) => {
        const { id, cmd, args } = payload;
        try {
          const value = await invoke(cmd, args ?? undefined);
          await invoke('remote_reply', { id, ok: true, value: value ?? null });
        } catch (e) {
          await invoke('remote_reply', { id, ok: false, error: typeof e === 'string' ? e : String((e as Error)?.message ?? e) });
        }
      })
    );

    unlisteners.push(
      listen<string[]>('remote-subscribe', ({ payload }) => {
        for (const name of payload) {
          if (subscribed.has(name) || name.startsWith('remote-')) continue;
          subscribed.add(name);
          unlisteners.push(listen(name, (e) => invoke('remote_event', { name, payload: e.payload ?? null }).catch(() => {})));
        }
      })
    );

    return () => {
      unlisteners.forEach((u) => u.then((fn) => fn()));
    };
  }, []);
  return null;
}

function MobileBootstrap() {
  useEffect(() => {
    adoptTokenFromHash();
    const original = window.fetch.bind(window);
    const patched: typeof fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const token = getToken();
      if (token && new URL(url, location.href).pathname.startsWith('/agent/')) {
        const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
        headers.set('Authorization', `Bearer ${token}`);
        return original(input, { ...init, headers });
      }
      return original(input, init);
    }, original);
    window.fetch = patched;
    return () => {
      window.fetch = original;
    };
  }, []);
  return null;
}

export function RemoteBridge() {
  return IS_MOBILE ? <MobileBootstrap /> : <DesktopRelay />;
}
