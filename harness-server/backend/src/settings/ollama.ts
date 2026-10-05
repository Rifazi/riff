import { normalizeOllamaEndpoint } from './settings.js';
import { getSettings } from './settings-store.js';

// The "ollama" provider: the system's own Ollama server (docs: ollama.com),
// where the human keeps their bigger local models (e.g. Qwen). Two endpoints
// matter: <endpoint>/api/tags lists what's installed (with capabilities, so
// the UI can prefer tools-capable models), and <endpoint>/v1 is the
// OpenAI-compatible chat API the AI SDK drives (agents/sdk-client.ts) —
// models there support tool calling natively, unlike Riff's built-in
// llama-helper model, which stays for single-shot calls only.

export interface OllamaModel {
  name: string;
  // The agent roles are tool-calling loops, so a model without the "tools"
  // capability can't drive them. Older Ollama versions don't report
  // capabilities at all — assume yes there rather than hiding every model.
  tools: boolean;
}

/** Normalized Ollama server URL from settings (trimmed, no trailing slash). */
export async function ollamaEndpoint(): Promise<string> {
  const settings = await getSettings();
  return normalizeOllamaEndpoint(settings.ollamaEndpoint);
}

/** OpenAI-compatible base URL for @ai-sdk/openai — `<endpoint>/v1`. */
export function openAICompatBase(endpoint: string): string {
  return `${normalizeOllamaEndpoint(endpoint)}/v1`;
}

/**
 * Installed models from GET /api/tags. Throws (with a human-readable
 * reason) when the server can't be reached — `endpointOverride` is the
 * Settings form's unsaved value, the stored endpoint otherwise.
 */
export async function listOllamaModels(endpointOverride?: string): Promise<OllamaModel[]> {
  const endpoint = endpointOverride && endpointOverride.trim() ? normalizeOllamaEndpoint(endpointOverride) : await ollamaEndpoint();
  let res: Response;
  try {
    res = await fetch(`${endpoint}/api/tags`, { signal: AbortSignal.timeout(3000) });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Can't reach Ollama at ${endpoint} — is it running? (${reason})`);
  }
  if (!res.ok) throw new Error(`Ollama at ${endpoint} responded with ${res.status}.`);
  const data = (await res.json()) as { models?: { name?: unknown; capabilities?: unknown }[] };
  const models = Array.isArray(data.models) ? data.models : [];
  return models
    .filter((m): m is { name: string; capabilities?: unknown } => typeof m?.name === 'string' && m.name.length > 0)
    .map((m) => ({
      name: m.name,
      tools: !Array.isArray(m.capabilities) || (m.capabilities as unknown[]).includes('tools'),
    }));
}

/**
 * Settings → Dev Agents → Test for the ollama provider: the server must be
 * reachable, and when a model is given it must be installed and able to call
 * tools. Returns the installed models on success; throws with the reason on
 * failure.
 */
export async function testOllama(model?: string, endpointOverride?: string): Promise<OllamaModel[]> {
  const models = await listOllamaModels(endpointOverride);
  if (model) {
    const match = models.find((m) => m.name === model || m.name.startsWith(`${model}:`));
    if (!match) {
      throw new Error(
        `"${model}" is not installed in Ollama — available: ${models.map((m) => m.name).join(', ') || '(none)'}.`
      );
    }
    if (!match.tools) {
      throw new Error(`"${model}" is installed but doesn't support tool calling — the agents need a tools-capable model.`);
    }
  }
  return models;
}