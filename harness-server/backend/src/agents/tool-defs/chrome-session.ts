import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A headless Chrome driven over the DevTools protocol, for screenshots that
 * need more than "load this URL": it can sign in through the app's own login
 * form first. Dependency-free (Node's global WebSocket); one browser per capture,
 * with a throwaway profile, so nothing leaks between sessions.
 */

export interface PageLogin {
  /** The login page, relative to the app. Default "/login". */
  path?: string;
  username: string;
  password: string;
}

export interface CaptureOptions {
  chrome: string;
  url: string;
  width: number;
  height: number;
  dark: boolean;
  login?: PageLogin;
  /** Where the png goes. */
  file: string;
}

const LOGIN_TIMEOUT_MS = 20_000;
const SETTLE_MS = 2_000;

interface Pending {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
}

class Cdp {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private listeners = new Map<string, Array<() => void>>();

  private constructor(private ws: WebSocket) {
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${msg.error.message}`));
        else p.resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.listeners.get(msg.method) ?? []) fn();
      }
    });
    ws.addEventListener('close', () => {
      for (const p of this.pending.values()) p.reject(new Error('Chrome closed the connection.'));
      this.pending.clear();
    });
  }

  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('Could not connect to headless Chrome.')));
    });
    return new Cdp(ws);
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  once(method: string): Promise<void> {
    return new Promise((resolve) => {
      const fn = () => {
        this.listeners.set(method, (this.listeners.get(method) ?? []).filter((l) => l !== fn));
        resolve();
      };
      this.listeners.set(method, [...(this.listeners.get(method) ?? []), fn]);
    });
  }

  async evaluate<T>(expression: string): Promise<T> {
    const res = await this.send<{ result: { value: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true }
    );
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text);
    return res.result.value;
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      // already closed
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function launch(chrome: string, profile: string, width: number, height: number): Promise<{ proc: ChildProcess; pageWs: string }> {
  const proc = spawn(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--force-device-scale-factor=1',
      `--window-size=${width},${height}`,
      `--user-data-dir=${profile}`,
      '--remote-debugging-port=0',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  );
  const port = await new Promise<number>((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Chrome did not start its debugging port in time.')), 15_000);
    proc.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      const match = /ws:\/\/127\.0\.0\.1:(\d+)\//.exec(output);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Chrome exited (${code}) before it was ready.`));
    });
  });
  for (let i = 0; i < 30; i++) {
    try {
      const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{ type: string; webSocketDebuggerUrl?: string }>;
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page?.webSocketDebuggerUrl) return { proc, pageWs: page.webSocketDebuggerUrl };
    } catch {
      // not up yet
    }
    await sleep(200);
  }
  proc.kill();
  throw new Error('Chrome started but offered no page to drive.');
}

async function navigate(cdp: Cdp, url: string): Promise<void> {
  const loaded = cdp.once('Page.loadEventFired');
  const nav = await cdp.send<{ errorText?: string }>('Page.navigate', { url });
  if (nav.errorText) throw new Error(`Chrome could not open ${url}: ${nav.errorText}`);
  await Promise.race([loaded, sleep(20_000)]);
}

/** Runs in the page: fills the password field and the field before it and clicks submit. A submit that navigates would kill this call, so it returns straight away. */
function loginScript(username: string, password: string): string {
  return `(async () => {
    const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const find = async () => {
      const end = Date.now() + 10000;
      while (Date.now() < end) {
        const pw = [...document.querySelectorAll('input[type="password"]')].find(visible);
        if (pw) return pw;
        await sleep(250);
      }
      return null;
    };
    const set = (el, value) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      el.focus();
      setter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const pw = await find();
    if (!pw) return { ok: false, reason: 'No password field appeared on the login page.' };
    const scope = pw.form || document;
    const inputs = [...scope.querySelectorAll('input')].filter((i) => visible(i) && /^(text|email|tel|)$/i.test(i.getAttribute('type') || ''));
    const before = inputs.filter((i) => pw.compareDocumentPosition(i) & Node.DOCUMENT_POSITION_PRECEDING);
    const user = before[before.length - 1] || inputs[0];
    if (!user) return { ok: false, reason: 'No username or email field found next to the password field.' };
    set(user, ${JSON.stringify(username)});
    set(pw, ${JSON.stringify(password)});
    await sleep(150);
    const form = pw.form;
    const button = (form || document).querySelector('button[type="submit"], input[type="submit"]') ||
      [...(form || document).querySelectorAll('button')].find(visible);
    if (button) button.click();
    else if (form) form.requestSubmit();
    else pw.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    return { ok: true, startPath: location.pathname };
  })()`;
}

const PROBE = `(() => {
  const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const alert = document.querySelector('[role="alert"], .error, [class*="error"]');
  return { path: location.pathname, form: [...document.querySelectorAll('input[type="password"]')].some(visible), message: alert && alert.textContent ? alert.textContent.trim().slice(0, 200) : '' };
})()`;

/** After submitting: null once the login form is gone or the page moved on, else why it didn't work. */
async function waitForLogin(cdp: Cdp, startPath: string): Promise<string | null> {
  const end = Date.now() + LOGIN_TIMEOUT_MS;
  let last = '';
  while (Date.now() < end) {
    await sleep(400);
    try {
      const state = await cdp.evaluate<{ path: string; form: boolean; message: string }>(PROBE);
      if (!state.form || state.path !== startPath) return null;
      last = state.message;
    } catch {
      // the page is navigating
    }
  }
  return `the login form was still showing after submitting.${last ? ` The page says: ${last}` : ''}`;
}

/** Opens the page (signing in first when asked) and writes a png of it. */
export async function captureWithChrome(opts: CaptureOptions): Promise<void> {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'riff-chrome-'));
  let proc: ChildProcess | undefined;
  let cdp: Cdp | undefined;
  try {
    const launched = await launch(opts.chrome, profile, opts.width, opts.height);
    proc = launched.proc;
    cdp = await Cdp.connect(launched.pageWs);
    await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: opts.width, height: opts.height, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: opts.dark ? 'dark' : 'light' }] });

    if (opts.login) {
      const origin = new URL(opts.url).origin;
      const loginPath = opts.login.path?.startsWith('/') ? opts.login.path : `/${opts.login.path ?? 'login'}`;
      await navigate(cdp, `${origin}${loginPath}`);
      const result = await cdp.evaluate<{ ok: boolean; reason?: string; startPath?: string }>(loginScript(opts.login.username, opts.login.password));
      if (!result.ok) throw new Error(`Could not sign in at ${origin}${loginPath}: ${result.reason}`);
      const failure = await waitForLogin(cdp, result.startPath ?? loginPath);
      if (failure) throw new Error(`Could not sign in at ${origin}${loginPath}: ${failure}`);
      await sleep(SETTLE_MS);
    }

    await navigate(cdp, opts.url);
    await sleep(SETTLE_MS);
    const shot = await cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
    await fs.writeFile(opts.file, Buffer.from(shot.data, 'base64'));
  } finally {
    cdp?.close();
    proc?.kill('SIGKILL');
    await fs.rm(profile, { recursive: true, force: true }).catch(() => undefined);
  }
}
