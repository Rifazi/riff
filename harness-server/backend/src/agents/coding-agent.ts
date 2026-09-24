import { promises as fs } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import type { ToolSet } from 'ai';
import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../config.js';
import { appendTranscriptEntry, getSession, setClaudeSessionId, setHistory, updateSession } from '../sessions/session-store.js';
import type { SessionRecord } from '../sessions/session.js';
import { getCredential, getRoleModelConfig } from '../settings/settings-store.js';
import { getPromptOverride } from '../settings/prompts-store.js';
import { getApp } from '../apps/apps-store.js';
import { applyAttachments, type ParsedAttachment } from './attachments.js';
import { runAgentTurn, runClaudeAgentTurn, type AgentEvent } from './sdk-client.js';
import { createDocsSearchTools } from './tool-defs/docs-search-tool.js';
import { createSearchCodeTool } from './tool-defs/code-search-tool.js';
import { createFileTools } from './tool-defs/file-tools.js';
import { createGitTools } from './tool-defs/git-tools.js';
import { createGenerateTools } from './tool-defs/generate-tools.js';
import { createWriteCodingPlanTool } from './tool-defs/coding-plan-tool.js';
import { createQaTools } from './tool-defs/qa-tools.js';
import { createRunPrettierTool } from './tool-defs/format-tool.js';
import { createRunNpmInstallTool } from './tool-defs/npm-install-tool.js';
import { createDocsSearchToolsClaude } from './tool-defs-claude/docs-search-tool.js';
import { createSearchCodeToolClaude } from './tool-defs-claude/code-search-tool.js';
import { createFileToolsClaude } from './tool-defs-claude/file-tools.js';
import { createGitToolsClaude } from './tool-defs-claude/git-tools.js';
import { createGenerateToolsClaude } from './tool-defs-claude/generate-tools.js';
import { createWriteCodingPlanToolClaude } from './tool-defs-claude/coding-plan-tool.js';
import { createQaToolsClaude } from './tool-defs-claude/qa-tools.js';
import { createRunPrettierToolClaude } from './tool-defs-claude/format-tool.js';
import { createRunNpmInstallToolClaude } from './tool-defs-claude/npm-install-tool.js';

const PROMPT_PATH = path.join(config.harnessRoot, 'backend/src/agents/prompts/coding-agent.md');
const TOOL_NAMES = [
  'search_docs',
  'read_doc',
  'search_code',
  'read_file',
  'write_file',
  'edit_file',
  'git_create_branch',
  'git_commit',
  'run_generate_paths',
  'run_generate_openapi',
  'write_coding_plan',
  'run_checked_command',
  'run_prettier',
  'run_npm_install',
];

export async function runCodingAgentTurn(
  session: SessionRecord,
  userMessage: string,
  onEvent: (event: AgentEvent) => void,
  attachments: ParsedAttachment[] = []
): Promise<SessionRecord> {
  await appendTranscriptEntry(session.id, 'coding', { role: 'user', text: userMessage });
  let prompt = await applyAttachments(session.id, 'coding', userMessage, attachments);

  const app = await getApp(session.appId);
  const { provider, model } = await getRoleModelConfig('coding');

  const promptTemplate = await fs.readFile(PROMPT_PATH, 'utf8');
  const override = await getPromptOverride(app.id, 'coding');
  const isFirstTurn = provider === 'claude' ? !session.claudeSessionIds.coding : session.histories.coding.length === 0;

  let systemPrompt = override ?? promptTemplate;
  if (isFirstTurn) {
    if (!session.requirementsPath) {
      throw new Error('Cannot start the coding stage without an approved requirements document.');
    }
    if (!session.planPath) {
      throw new Error('Cannot start the coding stage without an approved plan document.');
    }
    const requirementsRaw = await fs.readFile(path.join(config.harnessRoot, session.requirementsPath), 'utf8');
    const parsed = matter(requirementsRaw);
    systemPrompt += `\n\n# Approved requirements document (${session.requirementsPath})\n\n${requirementsRaw}`;

    const relatedDocs: string[] = Array.isArray(parsed.data['related-docs']) ? parsed.data['related-docs'] : [];
    for (const relDoc of relatedDocs) {
      try {
        const docContent = await fs.readFile(path.join(app.repoRoot, relDoc), 'utf8');
        systemPrompt += `\n\n# Related doc: ${relDoc}\n\n${docContent}`;
      } catch {
        // referenced doc no longer exists — skip it
      }
    }

    const planRaw = await fs.readFile(path.join(config.harnessRoot, session.planPath), 'utf8');
    const planParsed = matter(planRaw);
    systemPrompt += `\n\n# Approved plan (${session.planPath})\n\n${planRaw}`;

    const planSteps: unknown = planParsed.data.steps;
    if (Array.isArray(planSteps) && planSteps.length > 0) {
      const stepsList = planSteps
        .map((s: { id: string; title: string }) => `- id: "${s.id}", title: "${s.title}"`)
        .join('\n');
      systemPrompt +=
        `\n\n# Seed for write_coding_plan\n\nYour very first tool call, right after git_create_branch, must ` +
        `be write_coding_plan using exactly these steps (same id and title, do not invent your own) — all ` +
        `status "pending" except the first, which is "in_progress":\n\n${stepsList}`;
    }

    systemPrompt += `\n\n# Session\n\nSuggested branch name: ${suggestedBranchName(session)}`;
  }

  // A mid-coding send-back that's just been reconciled through requirements
  // and plan again also needs the (possibly changed) docs re-injected —
  // it isn't this agent's first-ever turn (codingReconciliationPending is
  // only ever set once a branch already exists), so for the "claude"
  // provider this resumes an existing SDK session via `resume: sessionId`,
  // which does NOT re-apply a new system prompt on resume. So this has to
  // travel as part of the actual turn prompt instead of systemPrompt,
  // which both engines guarantee delivering on every turn regardless of
  // provider or resume state.
  if (session.codingReconciliationPending) {
    if (!session.requirementsPath) {
      throw new Error('Cannot reconcile the coding stage without an approved requirements document.');
    }
    if (!session.planPath) {
      throw new Error('Cannot reconcile the coding stage without an approved plan document.');
    }
    const requirementsRaw = await fs.readFile(path.join(config.harnessRoot, session.requirementsPath), 'utf8');
    const planRaw = await fs.readFile(path.join(config.harnessRoot, session.planPath), 'utf8');
    const existingChecklist =
      session.codingPlan && session.codingPlan.length > 0
        ? session.codingPlan.map((s) => `- id: "${s.id}", status: "${s.status}", title: "${s.title}"`).join('\n')
        : '(none recorded)';
    const contextBlock =
      `# Approved requirements document (${session.requirementsPath})\n\n${requirementsRaw}\n\n` +
      `# Approved plan (${session.planPath})\n\n${planRaw}\n\n` +
      `# Requirements/plan were just revised\n\nYou are resuming on the EXISTING branch "${session.branch}" — ` +
      `do NOT call git_create_branch again. The requirements and/or plan above may have changed since your ` +
      `earlier turns in this conversation; treat any assumption from your prior work that now conflicts with ` +
      `them as superseded. Your next tool call should be write_coding_plan with a *reconciled* checklist: keep ` +
      `the id and status of steps that are still valid, and only add/drop/reword what the change actually ` +
      `affects — do not reset everything to "pending".\n\nExisting checklist:\n${existingChecklist}`;
    prompt = `${contextBlock}\n\n---\n\n${prompt}`;
  }

  const onBranchCreated = async (branchName: string) => {
    await updateSession(session.id, { branch: branchName, stage: 'coding-in-progress' });
  };

  const wrappedOnEvent = (event: AgentEvent) => {
    onEvent(event);
    void persistEvent(session.id, event);
  };

  if (provider === 'claude') {
    const { searchDocsToolClaude, readDocToolClaude } = createDocsSearchToolsClaude({ appId: app.id });
    const { readFileToolClaude, writeFileToolClaude, editFileToolClaude } = createFileToolsClaude({ repoRoot: app.repoRoot });
    const { gitCreateBranchTool, gitCommitTool } = createGitToolsClaude({ repoRoot: app.repoRoot, onBranchCreated });
    const { runGeneratePathsToolClaude, runGenerateOpenApiToolClaude } = createGenerateToolsClaude({ repoRoot: app.repoRoot });
    const { runCheckedCommandToolClaude } = createQaToolsClaude({ repoRoot: app.repoRoot, checkCommands: app.checkCommands });
    const createMcpServer = () =>
      createSdkMcpServer({
        name: 'harness-tools',
        version: '1.0.0',
        tools: [
          searchDocsToolClaude,
          readDocToolClaude,
          createSearchCodeToolClaude({ repoRoot: app.repoRoot }),
          readFileToolClaude,
          writeFileToolClaude,
          editFileToolClaude,
          gitCreateBranchTool,
          gitCommitTool,
          runGeneratePathsToolClaude,
          runGenerateOpenApiToolClaude,
          createWriteCodingPlanToolClaude(session.id),
          runCheckedCommandToolClaude,
          createRunPrettierToolClaude({ repoRoot: app.repoRoot }),
          createRunNpmInstallToolClaude({ repoRoot: app.repoRoot }),
        ],
      });

    const { sdkSessionId } = await runClaudeAgentTurn({
      systemPrompt,
      createMcpServer,
      toolNames: TOOL_NAMES,
      model,
      resumeSessionId: session.claudeSessionIds.coding,
      prompt,
      cwd: app.repoRoot,
      onEvent: wrappedOnEvent,
    });

    await setClaudeSessionId(session.id, 'coding', sdkSessionId);
  } else {
    const apiKey = await getCredential(provider);
    if (!apiKey) {
      const message = `No API key configured for ${provider} — add one in Settings before starting the coding stage.`;
      onEvent({ type: 'error', message });
      await appendTranscriptEntry(session.id, 'coding', { role: 'system', text: message, isError: true });
      return session;
    }

    const { searchDocsTool, readDocTool } = createDocsSearchTools({ appId: app.id });
    const { readFileTool, writeFileTool, editFileTool } = createFileTools({ repoRoot: app.repoRoot });
    const { gitCreateBranchTool, gitCommitTool } = createGitTools({ repoRoot: app.repoRoot, onBranchCreated });
    const { runGeneratePathsTool, runGenerateOpenApiTool } = createGenerateTools({ repoRoot: app.repoRoot });
    const { runCheckedCommandTool } = createQaTools({ repoRoot: app.repoRoot, checkCommands: app.checkCommands });

    const tools: ToolSet = {
      search_docs: searchDocsTool,
      read_doc: readDocTool,
      search_code: createSearchCodeTool({ repoRoot: app.repoRoot }),
      read_file: readFileTool,
      write_file: writeFileTool,
      edit_file: editFileTool,
      git_create_branch: gitCreateBranchTool,
      git_commit: gitCommitTool,
      run_generate_paths: runGeneratePathsTool,
      run_generate_openapi: runGenerateOpenApiTool,
      write_coding_plan: createWriteCodingPlanTool(session.id),
      run_checked_command: runCheckedCommandTool,
      run_prettier: createRunPrettierTool({ repoRoot: app.repoRoot }),
      run_npm_install: createRunNpmInstallTool({ repoRoot: app.repoRoot }),
    };

    const { updatedHistory } = await runAgentTurn({
      systemPrompt,
      tools,
      provider,
      model,
      apiKey,
      history: session.histories.coding,
      prompt,
      onEvent: wrappedOnEvent,
    });

    await setHistory(session.id, 'coding', updatedHistory);
  }

  const latest = await getSession(session.id);
  if (!latest) throw new Error(`Session ${session.id} not found`);
  if (latest.branch && latest.stage === 'coding-in-progress') {
    return updateSession(session.id, { stage: 'coding-review' });
  }
  return latest;
}

function suggestedBranchName(session: SessionRecord): string {
  // Ticket id keeps whatever case the human typed it in (e.g. "API-1234")
  // rather than being forced to lowercase — it's a ticket key, not a slug.
  const key = session.sessionKey.trim().replace(/\s+/g, '_');
  const titleSlug = session.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return `${key}_${titleSlug}`;
}

async function persistEvent(sessionId: string, event: AgentEvent): Promise<void> {
  if (event.type === 'assistant_text') {
    await appendTranscriptEntry(sessionId, 'coding', { role: 'assistant', text: event.text });
  } else if (event.type === 'tool_call') {
    await appendTranscriptEntry(sessionId, 'coding', {
      role: 'tool_call',
      toolName: event.name,
      toolInput: event.input,
    });
  } else if (event.type === 'tool_result') {
    await appendTranscriptEntry(sessionId, 'coding', {
      role: 'tool_result',
      toolResult: event.content,
      isError: event.isError,
    });
  } else if (event.type === 'continuation') {
    await appendTranscriptEntry(sessionId, 'coding', {
      role: 'system',
      text: `↻ Turn budget reached — continuing automatically (round ${event.hop} of ${event.maxHops}).`,
    });
  }
}
