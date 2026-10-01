import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ToolSet } from 'ai';
import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../config.js';
import { appendTranscriptEntry, setClaudeSessionId, setHistory, updateSession, addStageUsage } from '../sessions/session-store.js';
import type { SessionRecord } from '../sessions/session.js';
import { getCredential, getRoleModelConfig } from '../settings/settings-store.js';
import { getPromptOverride } from '../settings/prompts-store.js';
import { themeContextForTurn } from '../themes/theme-context.js';
import { createAuditThemeTool } from './tool-defs/theme-audit-tool.js';
import { createAuditThemeToolClaude } from './tool-defs-claude/theme-audit-tool.js';
import { getApp } from '../apps/apps-store.js';
import { baseBranchFor } from '../apps/apps.js';
import { applyAttachments, type ParsedAttachment } from './attachments.js';
import { referenceDocsTurnNote } from '../sessions/reference-docs.js';
import { compactQaFindings } from '../sessions/qa-findings.js';
import { runAgentTurn, runClaudeAgentTurn, type AgentEvent } from './sdk-client.js';
import { createDocsSearchTools } from './tool-defs/docs-search-tool.js';
import { createSearchCodeTool } from './tool-defs/code-search-tool.js';
import { createOutlineFileTool } from './tool-defs/outline-tool.js';
import { createFileTools } from './tool-defs/file-tools.js';
import { createQaTools } from './tool-defs/qa-tools.js';
import { createWriteQaReportTool } from './tool-defs/write-qa-report-tool.js';
import { askMultipleChoiceTool, askQuestionTool } from './tool-defs/ask-question-tool.js';
import { createDocsSearchToolsClaude } from './tool-defs-claude/docs-search-tool.js';
import { createSearchCodeToolClaude } from './tool-defs-claude/code-search-tool.js';
import { createOutlineFileToolClaude } from './tool-defs-claude/outline-tool.js';
import { createFileToolsClaude } from './tool-defs-claude/file-tools.js';
import { createQaToolsClaude } from './tool-defs-claude/qa-tools.js';
import { createWriteQaReportToolClaude } from './tool-defs-claude/write-qa-report-tool.js';
import { askMultipleChoiceToolClaude, askQuestionToolClaude } from './tool-defs-claude/ask-question-tool.js';

const PROMPT_PATH = path.join(config.harnessRoot, 'backend/src/agents/prompts/qa-agent.md');
const TOOL_NAMES = [
  'search_docs',
  'read_doc',
  'search_code',
  'audit_theme',
  'read_file',
  'outline_file',
  'get_diff',
  'run_checked_command',
  'write_qa_report',
  'ask_multiple_choice',
  'ask_question',
];

export async function runQaAgentTurn(
  session: SessionRecord,
  userMessage: string,
  onEvent: (event: AgentEvent) => void,
  attachments: ParsedAttachment[] = []
): Promise<SessionRecord> {
  if (!session.branch || !session.requirementsPath) {
    throw new Error('QA needs a branch and an approved requirements document.');
  }
  // Narrowed locals, not `session.branch`/`session.requirementsPath` directly —
  // TS's flow narrowing above doesn't reach into the createMcpServer closure
  // below, which reads these properties from a different function scope.
  const branch = session.branch;
  const requirementsPath = session.requirementsPath;

  // A rerun after coding fixes starts a fresh QA conversation rather than
  // resuming the old one: that one's diffs, file reads and test logs are of
  // the pre-fix branch — stale, and re-billed on every step. What carries
  // over is the previous report's findings, in the system prompt below.
  let previousFindings: string | null = null;
  if (session.qaRerunPending) {
    if (session.qaReportPath) {
      try {
        previousFindings = compactQaFindings(await fs.readFile(path.join(config.harnessRoot, session.qaReportPath), 'utf8'));
      } catch {
        // report unreadable — the fresh pass just reviews from scratch
      }
    }
    session.histories.qa = [];
    session.claudeSessionIds.qa = null;
    await setHistory(session.id, 'qa', []);
    await setClaudeSessionId(session.id, 'qa', null);
    await updateSession(session.id, { qaRerunPending: false });
    session.qaRerunPending = false;
  }
  await appendTranscriptEntry(session.id, 'qa', { role: 'user', text: userMessage });
  let prompt = await applyAttachments(session.id, 'qa', userMessage, attachments);

  const app = await getApp(session.appId);
  const { provider, model } = await getRoleModelConfig('qa');

  const promptTemplate = await fs.readFile(PROMPT_PATH, 'utf8');
  const override = await getPromptOverride(app.id, 'qa');
  const isFirstTurn = provider === 'claude' ? !session.claudeSessionIds.qa : session.histories.qa.length === 0;

  let systemPrompt = override ?? promptTemplate;
  const themeContext = await themeContextForTurn(session, 'qa', app.repoRoot, isFirstTurn);
  systemPrompt += themeContext.system;
  prompt = themeContext.turnPrefix + prompt;
  if (isFirstTurn) {
    const requirementsRaw = await fs.readFile(path.join(config.harnessRoot, session.requirementsPath), 'utf8');
    systemPrompt += `\n\n# Approved requirements document (${session.requirementsPath})\n\n${requirementsRaw}`;
    systemPrompt += `\n\n# Session\n\nBranch to review: ${session.branch}`;
    if (previousFindings) {
      systemPrompt +=
        `\n\n# Your previous QA pass on this branch\n\nThe coding agent has since pushed fixes for these. Confirm ` +
        `each one is actually resolved, but still do the full review above — every acceptance criterion, lint ` +
        `and tests — since the fixes may have broken something else.\n\n${previousFindings}`;
    }
  }

  // What the human has already provided, so the agent reads it instead of
  // asking for it again (see sessions/reference-docs.ts).
  const referenceNote = await referenceDocsTurnNote(session, 'qa', isFirstTurn);
  if (referenceNote) prompt = `${referenceNote}\n\n---\n\n${prompt}`;

  const wrappedOnEvent = (event: AgentEvent) => {
    onEvent(event);
    void persistEvent(session.id, event);
  };

  if (provider === 'claude') {
    const { searchDocsToolClaude, readDocToolClaude } = createDocsSearchToolsClaude({ appId: app.id, sessionId: session.id });
    const { readFileToolClaude } = createFileToolsClaude({ repoRoot: app.repoRoot });
    const { runCheckedCommandToolClaude, getDiffToolClaude } = createQaToolsClaude({ repoRoot: app.repoRoot, baseBranch: baseBranchFor(app), checkCommands: app.checkCommands });
    const createMcpServer = () =>
      createSdkMcpServer({
        name: 'harness-tools',
        version: '1.0.0',
        tools: [
          searchDocsToolClaude,
          readDocToolClaude,
          createSearchCodeToolClaude({ repoRoot: app.repoRoot }),
          createOutlineFileToolClaude({ repoRoot: app.repoRoot }),
          createAuditThemeToolClaude({ repoRoot: app.repoRoot }),
          readFileToolClaude,
          getDiffToolClaude,
          runCheckedCommandToolClaude,
          createWriteQaReportToolClaude({
            sessionKey: session.sessionKey,
            sessionId: session.id,
            branch,
            requirementsPath,
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
      resumeSessionId: session.claudeSessionIds.qa,
      prompt,
      cwd: app.repoRoot,
      onEvent: wrappedOnEvent,
    });

    await setClaudeSessionId(session.id, 'qa', sdkSessionId);
  } else {
    const apiKey = await getCredential(provider);
    if (!apiKey) {
      const message = `No API key configured for ${provider} — add one in Settings before starting QA.`;
      onEvent({ type: 'error', message });
      await appendTranscriptEntry(session.id, 'qa', { role: 'system', text: message, isError: true });
      return session;
    }

    const { searchDocsTool, readDocTool } = createDocsSearchTools({ appId: app.id, sessionId: session.id });
    const { readFileTool } = createFileTools({ repoRoot: app.repoRoot });
    const { runCheckedCommandTool, getDiffTool } = createQaTools({ repoRoot: app.repoRoot, baseBranch: baseBranchFor(app), checkCommands: app.checkCommands });
    const tools: ToolSet = {
      search_docs: searchDocsTool,
      read_doc: readDocTool,
      search_code: createSearchCodeTool({ repoRoot: app.repoRoot }),
      outline_file: createOutlineFileTool({ repoRoot: app.repoRoot }),
      audit_theme: createAuditThemeTool({ repoRoot: app.repoRoot }),
      read_file: readFileTool,
      get_diff: getDiffTool,
      run_checked_command: runCheckedCommandTool,
      write_qa_report: createWriteQaReportTool({
        sessionKey: session.sessionKey,
        sessionId: session.id,
        branch,
        requirementsPath,
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
      history: session.histories.qa,
      prompt,
      onEvent: wrappedOnEvent,
    });

    await setHistory(session.id, 'qa', updatedHistory);
  }

  const qaReportFilePath = path.join(config.qaReportsDir, `${session.sessionKey}.md`);
  const qaReportPath = existsSync(qaReportFilePath)
    ? path.relative(config.harnessRoot, qaReportFilePath)
    : session.qaReportPath;

  return updateSession(session.id, {
    qaReportPath,
    qaStatus: qaReportPath ? (session.qaStatus ?? 'pending-review') : session.qaStatus,
  });
}

async function persistEvent(sessionId: string, event: AgentEvent): Promise<void> {
  if (event.type === 'usage') return addStageUsage(sessionId, 'qa', event.usage, event.toolOutput);
  if (event.type === 'assistant_text') {
    await appendTranscriptEntry(sessionId, 'qa', { role: 'assistant', text: event.text });
  } else if (event.type === 'tool_call') {
    await appendTranscriptEntry(sessionId, 'qa', { role: 'tool_call', toolName: event.name, toolInput: event.input });
  } else if (event.type === 'tool_result') {
    await appendTranscriptEntry(sessionId, 'qa', {
      role: 'tool_result',
      toolResult: event.content,
      isError: event.isError,
    });
  } else if (event.type === 'continuation') {
    await appendTranscriptEntry(sessionId, 'qa', {
      role: 'system',
      text: `↻ Turn budget reached — continuing automatically (round ${event.hop} of ${event.maxHops}).`,
    });
  }
}
