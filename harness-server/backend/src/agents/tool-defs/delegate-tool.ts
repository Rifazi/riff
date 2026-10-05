import { tool, type ToolSet } from 'ai';
import { OUT_OF_STEPS, runAgentTurn } from '../sdk-client.js';
import {
  DELEGATE_SYSTEM_PROMPT,
  delegateDescription,
  delegateSchema,
  runDelegation,
  type DelegateInput,
  type DelegateReport,
  type HelperRun,
} from '../delegate-core.js';
import { createDocsSearchTools } from './docs-search-tool.js';
import { createSearchCodeTool } from './code-search-tool.js';
import { createOutlineFileTool } from './outline-tool.js';
import { createFileExecutors, readFileDescription, readFileSchema } from './file-tools.js';

export { delegateSchema, delegateDescription } from '../delegate-core.js';

// Each helper is a short, read-only tool loop on the coding role's
// `delegateModel` in the system Ollama (settings/ollama.ts).
const HELPER_STEPS = 12;
const HELPER_TIMEOUT_MS = 180_000;
// Local models often run with a small context window: a helper reads in
// smaller pages than the paid agent does.
const HELPER_READ_LINES = 150;

export interface DelegateDeps {
  repoRoot: string;
  appId: string;
  sessionId?: string;
  model: string;
  onReport?: (report: DelegateReport) => void;
  // Defaults to a real helper on Ollama.
  runHelper?: (prompt: string) => Promise<HelperRun>;
}

export function createDelegateExecute(deps: DelegateDeps) {
  const runHelper = deps.runHelper ?? ((prompt: string) => runOllamaHelper(deps, prompt));
  return async (input: DelegateInput): Promise<string> => {
    const { text, report } = await runDelegation(input, runHelper);
    console.log(
      `[delegate] ${report.useful}/${report.tasks} useful, ≈${report.savedTokens} paid tokens saved, ` +
        `${report.usage.input + report.usage.output} local tokens on ${deps.model}`,
    );
    deps.onReport?.(report);
    return text;
  };
}

async function runOllamaHelper(deps: DelegateDeps, prompt: string): Promise<HelperRun> {
  const { readFileExecute } = createFileExecutors({ repoRoot: deps.repoRoot });
  const { searchDocsTool, readDocTool } = createDocsSearchTools({
    appId: deps.appId,
    sessionId: deps.sessionId,
    repoRoot: deps.repoRoot,
  });
  const tools: ToolSet = {
    search_code: createSearchCodeTool({ repoRoot: deps.repoRoot }),
    search_docs: searchDocsTool,
    read_doc: readDocTool,
    outline_file: createOutlineFileTool({ repoRoot: deps.repoRoot }),
    read_file: tool({
      description: readFileDescription,
      inputSchema: readFileSchema,
      execute: (args) => readFileExecute({ ...args, limit: args.limit ?? HELPER_READ_LINES }),
    }),
  };

  let readChars = 0;
  let modelError: string | null = null;
  const result = await runAgentTurn({
    systemPrompt: DELEGATE_SYSTEM_PROMPT,
    tools,
    provider: 'ollama',
    model: deps.model,
    apiKey: '',
    history: [],
    prompt,
    // Only read here: nothing reaches the paid agent's event stream.
    onEvent: (event) => {
      if (event.type === 'error') modelError ??= event.message;
      if (event.type === 'usage') readChars = Object.values(event.toolOutput ?? {}).reduce((acc, s) => acc + s.chars, 0);
    },
    compaction: { atTokens: Infinity, handoff: async () => ({ prompt: '' }), stepsPerHop: HELPER_STEPS, maxHops: 0 },
    abortSignal: AbortSignal.timeout(HELPER_TIMEOUT_MS),
  });
  // A helper that ran out of steps found nothing it could stand behind:
  // reported like nothing found, which costs the paid agent the least.
  const outOfSteps = result.isError && result.resultText.startsWith(OUT_OF_STEPS);
  return { text: outOfSteps ? '' : result.resultText, error: modelError, usage: result.usage, readChars };
}

export function createDelegateTool(deps: DelegateDeps) {
  return tool({ description: delegateDescription, inputSchema: delegateSchema, execute: createDelegateExecute(deps) });
}
