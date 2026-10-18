/**
 * Phone side of the remote-control bridge (see src-tauri/src/remote/mod.rs).
 * One WebSocket to the Mac carries every `invoke()` and the events the views
 * `listen()` to. The page is served by the Mac itself, so the origin is the host.
 */

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };
type Handler = (event: { event: string; payload: unknown; id: number }) => void;

const TOKEN_KEY = 'riff.remote.token';

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string) {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // private mode: the pairing then lasts until the tab closes
  }
}

/** A pairing link ends in `#token=…`; keep the token and drop it from the URL. */
export function adoptTokenFromHash() {
  if (typeof window === 'undefined') return;
  const m = /[#&]token=([0-9a-f]+)/.exec(window.location.hash);
  if (!m) return;
  setToken(m[1]);
  history.replaceState(null, '', window.location.pathname + window.location.search);
}

class Transport {
  private socket: WebSocket | null = null;
  private opening: Promise<WebSocket> | null = null;
  private seq = 0;
  private pending = new Map<string, Pending>();
  private listeners = new Map<string, Map<number, Handler>>();
  private nextListener = 0;
  private status: ((connected: boolean) => void)[] = [];

  onStatus(cb: (connected: boolean) => void) {
    this.status.push(cb);
    return () => {
      this.status = this.status.filter((s) => s !== cb);
    };
  }

  private open(): Promise<WebSocket> {
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve(this.socket);
    if (this.opening) return this.opening;
    const token = getToken();
    if (!token) return Promise.reject(new Error('Not paired with a Mac. Open the pairing link from Riff → Settings → Phone.'));
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?token=${token}`;
    this.opening = new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.onopen = () => {
        this.socket = ws;
        this.opening = null;
        // Re-subscribe after a reconnect.
        if (this.listeners.size) ws.send(JSON.stringify({ subscribe: [...this.listeners.keys()] }));
        this.status.forEach((s) => s(true));
        resolve(ws);
      };
      ws.onmessage = (m) => this.onMessage(String(m.data));
      ws.onerror = () => {
        this.opening = null;
        reject(new Error("Couldn't reach your Mac. Check Tailscale is connected and Riff is running."));
      };
      ws.onclose = () => {
        this.socket = null;
        this.opening = null;
        this.status.forEach((s) => s(false));
        this.pending.forEach((p) => p.reject(new Error('Lost the connection to your Mac.')));
        this.pending.clear();
        setTimeout(() => this.listeners.size && this.open().catch(() => {}), 2000);
      };
    });
    return this.opening;
  }

  private onMessage(raw: string) {
    let msg: { id?: string; ok?: boolean; value?: unknown; error?: string; event?: string; payload?: unknown };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.id) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.value ?? null);
      else p.reject(new Error(msg.error ?? 'The Mac returned an error'));
    } else if (msg.event) {
      this.listeners.get(msg.event)?.forEach((h, id) => h({ event: msg.event!, payload: msg.payload, id }));
    }
  }

  async invoke<T>(cmd: string, args?: unknown): Promise<T> {
    const ws = await this.open();
    const id = `${Date.now().toString(36)}-${++this.seq}`;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      ws.send(JSON.stringify({ id, cmd, args: args ?? null }));
    });
  }

  async listen(event: string, handler: Handler): Promise<() => void> {
    const id = this.nextListener++;
    let set = this.listeners.get(event);
    const isNew = !set;
    if (!set) this.listeners.set(event, (set = new Map()));
    set.set(id, handler);
    if (isNew) {
      try {
        const ws = await this.open();
        ws.send(JSON.stringify({ subscribe: [event] }));
      } catch {
        // retried on reconnect
      }
    }
    return () => {
      set!.delete(id);
    };
  }
}

export const transport = new Transport();

// Read a pairing link's token before anything (the layout's first invoke) needs it.
adoptTokenFromHash();
