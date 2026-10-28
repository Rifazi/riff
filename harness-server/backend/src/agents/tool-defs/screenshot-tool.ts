import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { tool, type ModelMessage } from 'ai';
import { z } from 'zod';
import { config } from '../../config.js';
import { ensureDependencies } from '../../repo/dependencies.js';
import { captureWithChrome, type PageLogin } from './chrome-session.js';

const execFileAsync = promisify(execFile);

export const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 820, height: 1180 },
  phone: { width: 390, height: 844 },
} as const;

export const screenshotSchema = z.object({
  path: z.string().optional().describe('The page to open, e.g. "/" or "/settings". Default "/".'),
  viewport: z.enum(['desktop', 'tablet', 'phone']).optional().describe('desktop 1440x900 (default), tablet 820x1180, phone 390x844.'),
  dark: z.boolean().optional().describe('Render with prefers-color-scheme: dark.'),
  height: z.number().int().min(300).max(4000).optional().describe('Capture this many pixels of page height, to see below the fold. Default is the viewport height.'),
  url: z.string().optional().describe('A server that is already running, e.g. "http://localhost:5173". Leave out to start the app\'s own dev server.'),
  login: z
    .object({
      path: z.string().optional().describe('The login page, e.g. "/login". Default "/login".'),
      username: z.string(),
      password: z.string(),
    })
    .optional()
    .describe(
      'Sign in through the app\'s own login form before capturing, for screens behind a login. Pass the credentials the user gave you. ' +
        'Remembered for the rest of this turn, so later screenshots sign in again without it.'
    ),
  steps: z
    .array(
      z.object({
        do: z.enum(['click', 'fill', 'press', 'goto', 'wait']),
        text: z.string().optional().describe('click: the visible text or aria-label of the button, link or tab. wait: text to wait for.'),
        selector: z.string().optional().describe('click / fill: a CSS selector, when text or label is ambiguous.'),
        label: z.string().optional().describe('fill: the field\'s label, placeholder, aria-label or name.'),
        value: z.string().optional().describe('fill: what to type, the option to choose in a select, or true/false for a checkbox.'),
        key: z.string().optional().describe('press: Enter, Tab, Escape, ArrowDown, ArrowUp or Space.'),
        path: z.string().optional().describe('goto: another path in the app.'),
        ms: z.number().int().min(0).max(10000).optional().describe('wait: milliseconds, when there is no text to wait for.'),
      })
    )
    .max(30)
    .optional()
    .describe(
      'Do these in order after the page (and login) is open, before the capture: click buttons and links, fill and submit forms, open other paths. ' +
        'Use it to reach screens that exist only after an action: the form behind an "Add" button, a detail page of a record you create with the form, a dialog, a tab. ' +
        'The result names the URL the browser ended on, so you can open the created record\'s page later with `path`. A step that finds nothing fails the call and lists what is on the page.'
    ),
});
export type ScreenshotInput = z.infer<typeof screenshotSchema>;

export const screenshotDescription =
  'Look at the running app. Starts its dev script (npm run dev, else start) if needed, opens a page in headless Chrome at the chosen ' +
  'viewport and color scheme, and returns the screenshot as an image you can see, plus the file it was saved to. This is how you tell ' +
  'whether a screen looks good: judge hierarchy, spacing rhythm, alignment, density, contrast and balance from what you see, not from the ' +
  'markup. Take the desktop and phone views of each screen you assess, and dark mode if the app supports it. Costs a few seconds and a few ' +
  'thousand tokens per image, so take only the screens that matter (at most 8 a turn). Screens behind a login: pass `login` ' +
  'with the credentials you were given and the tool fills in and submits the form for you. Without credentials such screens show the login ' +
  'page or an empty state: note that, and say you could not see the real screen. To reach a screen that needs clicks (a form behind a button, a record ' +
  'that must be created first, a dialog, another tab), pass `steps`: the tool clicks, fills forms and navigates for you, then captures where it ends up ' +
  'and reports that URL. Never ask the user to click through the app or create test data for you.';

export interface ScreenshotResult {
  text: string;
  image: { data: string; mediaType: 'image/png' };
  file: string;
}

interface DevServer {
  proc: ChildProcess;
  url: string;
}

const servers = new Map<string, Promise<DevServer>>();

const MAX_PER_TURN = 8;
const START_TIMEOUT_MS = 90_000;
const URL_PATTERN = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0):(\d+)/;

export function findChrome(): string | null {
  const candidates = [
    process.env.RIFF_CHROME,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  return candidates.find((c): c is string => Boolean(c) && existsSync(c as string)) ?? null;
}

/** The npm script that serves the app: dev, else start, else serve. */
export function devScriptFor(repoRoot: string): string | null {
  try {
    const scripts = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).scripts ?? {};
    return ['dev', 'start', 'serve'].find((s) => typeof scripts[s] === 'string') ?? null;
  } catch {
    return null;
  }
}

async function startDevServer(repoRoot: string): Promise<DevServer> {
  const script = devScriptFor(repoRoot);
  if (!script) throw new Error('The app has no dev, start or serve script in its package.json, so there is nothing to open. Pass `url` for a server that is already running.');
  await ensureDependencies(repoRoot);
  // A free port of our own, so a server already on the app's usual port (often another app) is never the one captured.
  const port = await freePort();
  const proc = spawn('npm', ['run', script], { cwd: repoRoot, detached: true, env: { ...process.env, PORT: String(port), BROWSER: 'none', FORCE_COLOR: '0', CI: '' } });
  return new Promise<DevServer>((resolve, reject) => {
    let output = '';
    const fail = (message: string) => {
      stopProcess(proc);
      reject(new Error(`${message}\n\nLast output:\n${output.slice(-1500)}`));
    };
    const timer = setTimeout(() => fail(`The dev server did not print a local URL within ${START_TIMEOUT_MS / 1000}s.`), START_TIMEOUT_MS);
    const onData = (chunk: Buffer) => {
      output += chunk.toString().replace(/\u001b\[[0-9;]*m/g, '');
      const match = URL_PATTERN.exec(output);
      if (match) {
        clearTimeout(timer);
        setTimeout(() => resolve({ proc, url: `http://localhost:${match[1]}` }), 1500);
      }
    };
    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`The dev server exited (${code}) before it was ready.\n\nLast output:\n${output.slice(-1500)}`));
    });
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

function stopProcess(proc: ChildProcess): void {
  try {
    if (proc.pid) process.kill(-proc.pid, 'SIGTERM');
  } catch {
    // already gone
  }
}

/** Stops the session's dev server once the turn that opened it is over. */
export async function stopScreenshotServer(sessionId: string): Promise<void> {
  const server = servers.get(sessionId);
  servers.delete(sessionId);
  if (server) await server.then((s) => stopProcess(s.proc)).catch(() => undefined);
}

export interface ScreenshotDeps {
  sessionId: string;
  repoRoot: string;
  /** Called with every capture, so a caller can keep the files (the visual review shows them to the human). */
  onCapture?: (shot: { file: string; text: string }) => void;
  /** Lets the agent point `url` at a server that is already running. Off by default: whatever sits on a localhost port may be a different app. */
  allowUrl?: boolean;
}

export function createScreenshotExecute(deps: ScreenshotDeps) {
  const capture = createCapture(deps);
  if (!deps.onCapture) return capture;
  return async (input: ScreenshotInput): Promise<ScreenshotResult> => {
    const result = await capture(input);
    deps.onCapture!({ file: result.file, text: result.text });
    return result;
  };
}

function createCapture(deps: ScreenshotDeps) {
  let taken = 0;
  let rememberedLogin: PageLogin | undefined;
  return async (input: ScreenshotInput): Promise<ScreenshotResult> => {
    if (taken >= MAX_PER_TURN) throw new Error(`That is ${MAX_PER_TURN} screenshots this turn. Work from the ones you have.`);
    const chrome = findChrome();
    if (!chrome) throw new Error('Google Chrome (or Chromium/Edge) was not found. Install it, or set RIFF_CHROME to its executable.');

    let base = input.url?.trim();
    if (base && !deps.allowUrl) throw new Error("`url` is not available here: the screenshot tool starts this app's own dev server. Call it again without `url`.");
    if (!base) {
      if (!servers.has(deps.sessionId)) servers.set(deps.sessionId, startDevServer(deps.repoRoot));
      try {
        base = (await servers.get(deps.sessionId)!).url;
      } catch (err) {
        servers.delete(deps.sessionId);
        throw err;
      }
    }
    const view = VIEWPORTS[input.viewport ?? 'desktop'];
    const pagePath = input.path?.startsWith('/') ? input.path : `/${input.path ?? ''}`;
    const target = `${base.replace(/\/$/, '')}${pagePath}`;

    const dir = path.join(config.stateDir, 'screenshots', deps.sessionId);
    await fs.mkdir(dir, { recursive: true });
    taken += 1;
    const file = path.join(dir, `${Date.now()}-${input.viewport ?? 'desktop'}${input.dark ? '-dark' : ''}.png`);
    const login = input.login ?? rememberedLogin;
    if (input.login) rememberedLogin = input.login;
    const steps = input.steps ?? [];
    const signedIn = login ? ', signed in' : '';
    if (login || steps.length) {
      let finalUrl = target;
      try {
        ({ finalUrl } = await captureWithChrome({ chrome, url: target, width: view.width, height: input.height ?? view.height, dark: Boolean(input.dark), login, steps, file }));
      } catch (err) {
        throw new Error(err instanceof Error ? err.message : String(err));
      }
      const shot = (await fs.readFile(file)).toString('base64');
      const rel = path.relative(config.harnessRoot, file);
      const after = steps.length ? ` after ${steps.length} step${steps.length === 1 ? '' : 's'}; the browser ended on ${finalUrl}` : '';
      return {
        text: `${target} at ${view.width}x${input.height ?? view.height}${input.dark ? ', dark' : ''}${signedIn}${after}. Saved to ${rel}.`,
        image: { data: shot, mediaType: 'image/png' },
        file: rel,
      };
    }
    const args = [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      `--window-size=${view.width},${input.height ?? view.height}`,
      '--virtual-time-budget=8000',
      ...(input.dark ? ['--force-dark-mode', '--blink-settings=preferredColorScheme=1'] : []),
      `--screenshot=${file}`,
      target,
    ];
    try {
      await execFileAsync(chrome, args, { timeout: 45_000 });
    } catch (err) {
      throw new Error(`Chrome could not capture ${target}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
    }
    const data = (await fs.readFile(file)).toString('base64');
    const where = path.relative(config.harnessRoot, file);
    return {
      text: `${target} at ${view.width}x${input.height ?? view.height}${input.dark ? ', dark' : ''}. Saved to ${where}.`,
      image: { data, mediaType: 'image/png' },
      file: where,
    };
  };
}

/** What a transcript keeps of a screenshot result: the text, never the pixels. */
export function withoutImages(content: unknown): unknown {
  if (Array.isArray(content)) {
    return content.map((block) =>
      block && typeof block === 'object' && (block as { type?: string }).type === 'image' ? { type: 'text', text: '[screenshot]' } : block
    );
  }
  if (content && typeof content === 'object' && 'image' in content) {
    const { image: _image, ...rest } = content as ScreenshotResult;
    return rest;
  }
  return content;
}

/** The AI-SDK form: the model gets the image this turn; the stored result keeps only the text. */
export function createScreenshotTool(deps: ScreenshotDeps) {
  return tool({
    description: screenshotDescription,
    inputSchema: screenshotSchema,
    execute: createScreenshotExecute(deps),
    toModelOutput: ({ output }) => ({
      type: 'content',
      value: [
        { type: 'text', text: (output as ScreenshotResult).text },
        { type: 'image-data', data: (output as ScreenshotResult).image.data, mediaType: 'image/png' },
      ],
    }),
  });
}

/** A turn's history without screenshot pixels, so later turns don't pay to re-send them. */
export function historyWithoutImages(history: ModelMessage[]): ModelMessage[] {
  return history.map((message) => {
    if (message.role !== 'tool') return message;
    return {
      ...message,
      content: message.content.map((part) => {
        const output = (part as { output?: { value?: unknown } }).output;
        if (part.type !== 'tool-result' || !output || typeof output !== 'object' || !('value' in output)) return part;
        return { ...part, output: { ...output, value: withoutImages(output.value) } };
      }),
    } as ModelMessage;
  });
}
