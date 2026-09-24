import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import type { ToolSet } from 'ai';
import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../config.js';
import { appendTranscriptEntry, setClaudeSessionId, setHistory, updateSession } from '../sessions/session-store.js';
import type { SessionRecord } from '../sessions/session.js';
import { getCredential, getRoleModelConfig } from '../settings/settings-store.js';
import { getPromptOverride } from '../settings/prompts-store.js';
import { getApp } from '../apps/apps-store.js';
import { diffStatAgainstBase } from '../repo/git.js';
import { applyAttachments, type ParsedAttachment } from './attachments.js';
import { runAgentTurn, runClaudeAgentTurn, type AgentEvent } from './sdk-client.js';
import { createDocsSearchTools } from './tool-defs/docs-search-tool.js';
import { createSearchCodeTool } from './tool-defs/code-search-tool.js';
import { createFileTools } from './tool-defs/file-tools.js';
import { createWritePlanTool } from './tool-defs/write-plan-tool.js';
import { askMultipleChoiceTool, askQuestionTool } from './tool-defs/ask-question-tool.js';
import { createDocsSearchToolsClaude } from './tool-defs-claude/docs-search-tool.js';
import { createSearchCodeToolClaude } from './tool-defs-claude/code-search-tool.js';
import { createFileToolsClaude } from './tool-defs-claude/file-tools.js';
import { createWritePlanToolClaude } from './tool-defs-claude/write-plan-tool.js';
import { askMultipleChoiceToolClaude, askQuestionToolClaude } from './tool-defs-claude/ask-question-tool.js';

const PROMPT_PATH = path.join(config.harnessRoot, 'backend/src/agents/prompts/plan-agent.md');
const TOOL_NAMES = [
  'search_docs',
  'read_doc',
  'search_code',
  'read_file',
  'write_plan_doc',
  'ask_multiple_choice',
  'ask_question',
];

export async function runPlanAgentTurn(
  session: SessionRecord,
  userMessage: string,
  onEvent: (event: AgentEvent) => void,
  attachments: ParsedAttachment[] = []
): Promise<SessionRecord> {
  await appendTranscriptEntry(session.id, 'plan', { role: 'user', text: userMessage });
  let prompt = await applyAttachments(session.id, 'plan', userMessage, attachments);

  const app = await getApp(session.appId);
  const { provider, model } = await getRoleModelConfig('plan');

  const promptTemplate = await fs.readFile(PROMPT_PATH, 'utf8');
  const override = await getPromptOverride(app.id, 'plan');
  const isFirstTurn = provider === 'claude' ? !session.claudeSessionIds.plan : session.histories.plan.length === 0;

  let systemPrompt = override ?? promptTemplate;
  if (isFirstTurn) {
    if (!session.requirementsPath) {
      throw new Error('Cannot start the plan stage without an approved requirements document.');
    }
    const requirementsRaw = await fs.readFile(path.join(config.harnessRoot, session.requirementsPath), 'utf8');
    systemPrompt += `\n\n# Approved requirements document (${session.requirementsPath})\n\n${requirementsRaw}`;
  }

  // Coding already has a branch — this plan revision needs to reconcile
  // against an existing checklist/branch, not seed one fresh. A branch can
  // only exist once plan (and requirements) have already been approved
  // once before, so this is never the first-ever plan turn — which means
  // for the "claude" provider this resumes an existing SDK session via
  // `resume: sessionId`, and that mechanism does NOT re-apply a new system
  // prompt on resume. So both the requirements doc (which may have just
  // changed — its resumed history holds a stale copy) and this
  // reconciliation context have to travel as part of the actual turn
  // prompt instead of systemPrompt, which both engines guarantee
  // delivering on every turn regardless of provider or resume state.
  if (session.branch) {
    if (!session.requirementsPath) {
      throw new Error('Cannot reconcile the plan stage without an approved requirements document.');
    }
    const requirementsRaw = await fs.readFile(path.join(config.harnessRoot, session.requirementsPath), 'utf8');

    let stepsText = 'No coding checklist recorded yet.';
    if (session.codingPlan && session.codingPlan.length > 0) {
      stepsText = session.codingPlan.map((s) => `- id: "${s.id}", status: "${s.status}", title: "${s.title}"`).join('\n');
    }
    let diffStat = '(unable to read diff stat)';
    try {
      diffStat = (await diffStatAgainstBase(app.repoRoot, session.branch)).trim() || '(no changes yet)';
    } catch {
      // repo/branch not in a readable state — proceed without it
    }
    const contextBlock =
      `# Approved requirements document (${session.requirementsPath})\n\n${requirementsRaw}\n\n` +
      `# Coding already in progress\n\nThe requirements above were just revised while coding had already ` +
      `started on branch "${session.branch}". Propose a *minimal* revision to the plan: preserve step ids and ` +
      `statuses for steps that are still valid, and only add/drop/reword steps the requirements change actually ` +
      `affects. Do not reseed the whole checklist from scratch.\n\n` +
      `Existing coding checklist:\n${stepsText}\n\nDiff stat against master:\n${diffStat}`;
    prompt = `${contextBlock}\n\n---\n\n${prompt}`;
  }

  const wrappedOnEvent = (event: AgentEvent) => {
    onEvent(event);
    void persistEvent(session.id, event);
  };

  if (provider === 'claude') {
    const { searchDocsToolClaude, readDocToolClaude } = createDocsSearchToolsClaude({ appId: app.id });
    const { readFileToolClaude } = createFileToolsClaude({ repoRoot: app.repoRoot });
    const createMcpServer = () =>
      createSdkMcpServer({
        name: 'harness-tools',
        version: '1.0.0',
        tools: [
          searchDocsToolClaude,
          readDocToolClaude,
          createSearchCodeToolClaude({ repoRoot: app.repoRoot }),
          readFileToolClaude,
          createWritePlanToolClaude({
            sessionKey: session.sessionKey,
            sessionId: session.id,
            requirementsPath: session.requirementsPath ?? '',
          }),
          askMultipleChoiceToolClaude,
          askQuestionToolClaude,
        ],
      });

    const { sdkSessionId } = await runClaudeAgentTurn({
      systemPrompt,
      createMcpServer,
      toolNames: TOOL_NAMES,
      model,
      resumeSessionId: session.claudeSessionIds.plan,
      prompt,
      cwd: app.repoRoot,
      onEvent: wrappedOnEvent,
    });

    await setClaudeSessionId(session.id, 'plan', sdkSessionId);
  } else {
    const apiKey = await getCredential(provider);
    if (!apiKey) {
      const message = `No API key configured for ${provider} — add one in Settings before starting the plan stage.`;
      onEvent({ type: 'error', message });
      await appendTranscriptEntry(session.id, 'plan', { role: 'system', text: message, isError: true });
      return session;
    }

    const { searchDocsTool, readDocTool } = createDocsSearchTools({ appId: app.id });
    const { readFileTool } = createFileTools({ repoRoot: app.repoRoot });
    const tools: ToolSet = {
      search_docs: searchDocsTool,
      read_doc: readDocTool,
      search_code: createSearchCodeTool({ repoRoot: app.repoRoot }),
      read_file: readFileTool,
      write_plan_doc: createWritePlanTool({
        sessionKey: session.sessionKey,
        sessionId: session.id,
        requirementsPath: session.requirementsPath ?? '',
      }),
      ask_multiple_choice: askMultipleChoiceTool,
      ask_question: askQuestionTool,
    };

    const { updatedHistory } = await runAgentTurn({
      systemPrompt,
      tools,
      provider,
      model,
      apiKey,
      history: session.histories.plan,
      prompt,
      onEvent: wrappedOnEvent,
    });

    await setHistory(session.id, 'plan', updatedHistory);
  }

  const planFilePath = path.join(config.plansDir, `${session.sessionKey}.md`);
  const fileExists = existsSync(planFilePath);
  const planPath = fileExists ? path.relative(config.harnessRoot, planFilePath) : session.planPath;

  // Same rule as requirements-agent.ts: write_plan_doc always writes
  // status: draft, including when it overwrites a previously-approved
  // plan mid-conversation — mirror that back onto the session record
  // instead of trusting the old value.
  let planStatus = session.planStatus;
  if (fileExists) {
    const fileStatus = matter(await fs.readFile(planFilePath, 'utf8')).data.status;
    if (fileStatus === 'draft' || fileStatus === 'approved' || fileStatus === 'superseded') {
      planStatus = fileStatus;
    } else if (planStatus == null) {
      planStatus = 'draft';
    }
  }

  const patch: Partial<SessionRecord> = { planPath, planStatus };
  if (session.planStatus === 'approved' && planStatus === 'draft') {
    patch.stage = 'plan-in-progress';
  }

  return updateSession(session.id, patch);
}

async function persistEvent(sessionId: string, event: AgentEvent): Promise<void> {
  if (event.type === 'assistant_text') {
    await appendTranscriptEntry(sessionId, 'plan', { role: 'assistant', text: event.text });
  } else if (event.type === 'tool_call') {
    await appendTranscriptEntry(sessionId, 'plan', {
      role: 'tool_call',
      toolName: event.name,
      toolInput: event.input,
    });
  } else if (event.type === 'tool_result') {
    await appendTranscriptEntry(sessionId, 'plan', {
      role: 'tool_result',
      toolResult: event.content,
      isError: event.isError,
    });
  } else if (event.type === 'continuation') {
    await appendTranscriptEntry(sessionId, 'plan', {
      role: 'system',
      text: `↻ Turn budget reached — continuing automatically (round ${event.hop} of ${event.maxHops}).`,
    });
  }
}
