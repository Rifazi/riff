import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { riffDataDir, riffEnv as env, riffRoot } from '../riff-paths.js';

// Riff's own built-in summary model (Qwen 3.5 via the llama-helper sidecar),
// reused here for the plain prompt→text calls that don't need a frontier
// model — free, and nothing leaves the machine. llama-helper speaks one JSON
// object per line over stdin/stdout (see <riff>/llama-helper/src/main.rs)
// and has no tool calling, so this is only for single-shot calls like the
// coordinator's continue/ready decision, never for an agent turn.

// Qwen only: its chat template is known (mirrors QWEN35_NONTHINKING_TEMPLATE
// in frontend/src-tauri/src/summary/summary_engine/models.rs). 4B first.
const MODEL_FILES = [
  { file: 'Qwen3.5-4B-Q4_K_M.gguf', name: 'qwen3.5:4b' },
  { file: 'Qwen3.5-2B-Q4_K_M.gguf', name: 'qwen3.5:2b' },
];

const IDLE_TIMEOUT_SECS = 300;
const REQUEST_TIMEOUT_MS = 120_000;

function targetTriple(): string {
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  if (process.platform === 'darwin') return `${arch}-apple-darwin`;
  if (process.platform === 'win32') return `${arch}-pc-windows-msvc`;
  return `${arch}-unknown-linux-gnu`;
}

function resolveHelper(): string | null {
  const exe = process.platform === 'win32' ? '.exe' : '';
  const candidates = [
    env('LLAMA_HELPER'),
    path.join(riffRoot(), 'target/release', `llama-helper${exe}`),
    path.join(riffRoot(), 'frontend/src-tauri/binaries', `llama-helper-${targetTriple()}${exe}`),
    process.platform === 'darwin' ? '/Applications/Riff.app/Contents/MacOS/llama-helper' : undefined,
  ];
  return candidates.find((p): p is string => Boolean(p && existsSync(p))) ?? null;
}

function resolveModel(): { path: string; name: string } | null {
  const override = env('LOCAL_MODEL');
  if (override && existsSync(override)) return { path: override, name: path.basename(override) };
  const dir = path.join(riffDataDir(), 'models/summary');
  for (const m of MODEL_FILES) {
    const p = path.join(dir, m.file);
    if (existsSync(p)) return { path: p, name: m.name };
  }
  return null;
}

export interface LocalModelStatus {
  available: boolean;
  model: string | null;
  reason: string | null;
}

export function localModelStatus(): LocalModelStatus {
  const model = resolveModel();
  if (!model) return { available: false, model: null, reason: "No Qwen model downloaded in Riff's built-in AI settings." };
  if (!resolveHelper()) return { available: false, model: model.name, reason: 'llama-helper not found — build Riff once.' };
  return { available: true, model: model.name, reason: null };
}

function escapeMarkers(text: string): string {
  return text
    .replace(/<\|im_start\|>/g, '< |im_start| >')
    .replace(/<\|im_end\|>/g, '< |im_end| >')
    .replace(/<think>/g, '< think >')
    .replace(/<\/think>/g, '< /think >');
}

function formatQwenPrompt(system: string, user: string): string {
  return (
    `<|im_start|>system\n${system}<|im_end|>\n<|im_start|>user\n${escapeMarkers(user)}<|im_end|>\n` +
    '<|im_start|>assistant\n<think>\n\n</think>\n\n'
  );
}

// One helper process, kept warm between calls; it exits by itself after
// IDLE_TIMEOUT_SECS without a request. Requests are serialized — it handles
// one generation at a time.
let child: ChildProcessWithoutNullStreams | null = null;
let pending: { resolve: (line: string) => void; reject: (err: Error) => void } | null = null;
let queue: Promise<unknown> = Promise.resolve();

function ensureChild(helper: string): ChildProcessWithoutNullStreams {
  if (child && child.exitCode === null && !child.killed) return child;
  const proc = spawn(helper, [], { env: { ...process.env, LLAMA_IDLE_TIMEOUT: String(IDLE_TIMEOUT_SECS) } });
  proc.stderr.resume(); // model-load and timing logs — not needed here
  createInterface({ input: proc.stdout }).on('line', (line) => {
    const p = pending;
    pending = null;
    p?.resolve(line);
  });
  proc.on('exit', () => {
    if (child === proc) child = null;
    const p = pending;
    pending = null;
    p?.reject(new Error('llama-helper exited'));
  });
  proc.on('error', (err) => {
    if (child === proc) child = null;
    const p = pending;
    pending = null;
    p?.reject(err);
  });
  child = proc;
  return proc;
}

/**
 * One plain completion from Riff's built-in model. Throws if the model or
 * helper isn't available, on timeout, or on a generation error — callers
 * fall back to their configured model.
 */
export function generateLocal(params: { system: string; prompt: string; maxTokens?: number }): Promise<string> {
  const run = async (): Promise<string> => {
    const model = resolveModel();
    const helper = resolveHelper();
    if (!model || !helper) throw new Error(localModelStatus().reason ?? 'Local model unavailable.');

    const proc = ensureChild(helper);
    const request = {
      type: 'generate',
      prompt: formatQwenPrompt(params.system, params.prompt),
      max_tokens: params.maxTokens ?? 512,
      context_size: 16384,
      model_path: model.path,
      temperature: 0.2,
      top_k: 20,
      top_p: 0.8,
      presence_penalty: 0,
      frequency_penalty: 0,
      repeat_penalty: 1.05,
      penalty_last_n: 256,
      stop_tokens: ['<|im_end|>'],
    };

    const line = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending = null;
        proc.kill();
        reject(new Error('Local model timed out.'));
      }, REQUEST_TIMEOUT_MS);
      pending = {
        resolve: (l) => {
          clearTimeout(timer);
          resolve(l);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      proc.stdin.write(`${JSON.stringify(request)}\n`);
    });

    const response = JSON.parse(line) as { type: string; text?: string; error?: string | null; message?: string };
    if (response.type === 'response' && !response.error) return (response.text ?? '').trim();
    throw new Error(response.error ?? response.message ?? `Unexpected llama-helper reply: ${line.slice(0, 200)}`);
  };
  const result = queue.then(run, run);
  queue = result.catch(() => undefined);
  return result;
}

/** Stops the helper now instead of waiting for its idle timeout (server shutdown). */
export function stopLocalModel(): void {
  child?.kill();
  child = null;
}
