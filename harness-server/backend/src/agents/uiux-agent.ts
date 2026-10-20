import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import type { ToolSet } from 'ai';
import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../config.js';
import { appendTranscriptEntry, getSession, setClaudeSessionId, setHistory, updateSession, addStageUsage } from '../sessions/session-store.js';
import type { SessionRecord } from '../sessions/session.js';
import { getApiKey, getRoleModelConfig } from '../settings/settings-store.js';
import { getPromptOverride } from '../settings/prompts-store.js';
import { getApp } from '../apps/apps-store.js';
import { docsDirFor } from '../apps/apps.js';
import { summarizeAppTheme } from '../themes/apply-theme.js';
import { applyAttachments, type ParsedAttachment } from './attachments.js';
import { referenceDocsTurnNote } from '../sessions/reference-docs.js';
import { runAgentTurn, runClaudeAgentTurn, type AgentEvent } from './sdk-client.js';
import { repoInstructionsNote } from './repo-instructions.js';
import { uiuxStylePrompt } from './uiux-prompt.js';
import { designMemoryForUiux } from '../themes/theme-context.js';
import { createRememberDesignTool } from './tool-defs/design-memory-tool.js';
import { createRememberDesignToolClaude } from './tool-defs-claude/design-memory-tool.js';
import { createDocsSearchTools } from './tool-defs/docs-search-tool.js';
import { createSearchCodeTool } from './tool-defs/code-search-tool.js';
import { createOutlineFileTool } from './tool-defs/outline-tool.js';
import { createFileTools } from './tool-defs/file-tools.js';
import { createAuditThemeTool } from './tool-defs/theme-audit-tool.js';
import { createAnalyzeColorsTool } from './tool-defs/color-tool.js';
import { createProposeThemeTool } from './tool-defs/propose-theme-tool.js';
import { createWriteRequirementsTool } from './tool-defs/write-requirements-tool.js';
import { createWritePlanTool } from './tool-defs/write-plan-tool.js';
import { createStartCodingTool } from './tool-defs/start-coding-tool.js';
import { askMultipleChoiceTool, askQuestionTool } from './tool-defs/ask-question-tool.js';
import { createScreenshotTool, findChrome, historyWithoutImages, stopScreenshotServer, withoutImages } from './tool-defs/screenshot-tool.js';
import { createDocsSearchToolsClaude } from './tool-defs-claude/docs-search-tool.js';
import { createSearchCodeToolClaude } from './tool-defs-claude/code-search-tool.js';
import { createOutlineFileToolClaude } from './tool-defs-claude/outline-tool.js';
import { createFileToolsClaude } from './tool-defs-claude/file-tools.js';
import { createAuditThemeToolClaude } from './tool-defs-claude/theme-audit-tool.js';
import { createAnalyzeColorsToolClaude } from './tool-defs-claude/color-tool.js';
import { createProposeThemeToolClaude } from './tool-defs-claude/propose-theme-tool.js';
import { createWriteRequirementsToolClaude } from './tool-defs-claude/write-requirements-tool.js';
import { createWritePlanToolClaude } from './tool-defs-claude/write-plan-tool.js';
import { createStartCodingToolClaude } from './tool-defs-claude/start-coding-tool.js';
import { askMultipleChoiceToolClaude, askQuestionToolClaude } from './tool-defs-claude/ask-question-tool.js';
import { createScreenshotToolClaude } from './tool-defs-claude/screenshot-tool.js';

const PROMPT_PATH = path.join(config.harnessRoot, 'backend/src/agents/prompts/uiux-agent.md');
const TOOL_NAMES = [
  'search_docs',
  'read_doc',
  'search_code',
  'outline_file',
  'read_file',
  'read_files',
  'audit_theme',
  'analyze_colors',
  'propose_theme',
  'remember_design',
  'write_requirements_doc',
  'write_plan_doc',
  'start_coding',
  'ask_multiple_choice',
  'ask_question',
];

const NO_SCREENSHOTS_NOTE =
  "\n\n# Screenshots are unavailable on this model\n\nYou can't take screenshots in this session, so you judge from the code and from analyze_colors. Say so in " +
  'the requirements and mark every visual judgement "from code, not seen". Switching the UI/UX agent to a Claude, OpenAI or Google model in Settings → Dev Agents enables screenshots.';

const NO_CHROME_NOTE =
  '\n\n# Screenshots are unavailable: Chrome was not found\n\nInstall Google Chrome (or set RIFF_CHROME to a Chromium executable) to enable screenshots. Until then judge from code and analyze_colors, and mark every visual judgement "from code, not seen".';

/**
 * The UI/UX lead. Takes the requirements stage's place in a UI/UX session
 * (same chat, transcript and documents), but looks at the app, writes both
 * the requirements and the plan, and hands over to coding itself.
 */
export async function runUiuxAgentTurn(
  session: SessionRecord,
  userMessage: string,
  onEvent: (event: AgentEvent) => void,
  attachments: ParsedAttachment[] = [],
): Promise<SessionRecord> {
  await appendTranscriptEntry(session.id, 'requirements', { role: 'user', text: userMessage });
  let prompt = await applyAttachments(session.id, 'requirements', userMessage, attachments);

  const app = await getApp(session.appId);
  const { provider, model } = await getRoleModelConfig('uiux');
  const isFirstTurn = provider === 'claude' ? !session.claudeSessionIds.requirements : session.histories.requirements.length === 0;
  // Ollama's local models can't be assumed to read images; every other engine can.
  const sees = provider !== 'ollama';
  const screenshots = sees && findChrome() !== null;

  const override = await getPromptOverride(app.id, 'uiux');
  let systemPrompt = override ?? (await fs.readFile(PROMPT_PATH, 'utf8'));
  systemPrompt += await uiuxStylePrompt();
  if (isFirstTurn) {
    systemPrompt += repoInstructionsNote(app.repoRoot);
    try {
      systemPrompt += `\n\n# Docs manifest (docs/README.md)\n\n${await fs.readFile(path.join(docsDirFor(app), 'README.md'), 'utf8')}`;
    } catch {
      // no manifest — proceed without it
    }
    const theme = summarizeAppTheme(app.repoRoot);
    systemPrompt += `\n\n# This app's theme\n\n${theme ? `The app's UI theme is "${theme.name}" (theme/theme.json).` : 'The app has no UI theme yet.'}`;
  }
  const memory = await designMemoryForUiux(session, isFirstTurn);
  systemPrompt += memory.system;
  if (!sees) systemPrompt += NO_SCREENSHOTS_NOTE;
  else if (!screenshots) systemPrompt += NO_CHROME_NOTE;

  const referenceNote = await referenceDocsTurnNote(session, 'requirements', isFirstTurn);
  if (referenceNote) prompt = `${referenceNote}\n\n---\n\n${prompt}`;
  prompt = memory.turnPrefix + prompt;

  const toolNames = new Map<string, string>();
  const wrappedOnEvent = (event: AgentEvent) => {
    const safe = event.type === 'tool_result' ? { ...event, content: withoutImages(event.content) } : event;
    onEvent(safe);
    if (safe.type === 'tool_call') toolNames.set(safe.toolCallId, safe.name);
    void persistEvent(session.id, safe, safe.type === 'tool_result' ? toolNames.get(safe.toolCallId) : undefined);
  };

  const sessionKey = session.sessionKey;
  const requirementsPath = path.relative(config.harnessRoot, path.join(config.requirementsDir, `${sessionKey}.md`));
  const docInfo = { sessionKey, ticket: session.ticket, sessionId: session.id };

  try {
    if (provider === 'claude') {
      const { searchDocsToolClaude, readDocToolClaude } = createDocsSearchToolsClaude({ appId: app.id, sessionId: session.id });
      const { readFileToolClaude, readFilesToolClaude } = createFileToolsClaude({ repoRoot: app.repoRoot });
      const createMcpServer = () =>
        createSdkMcpServer({
          name: 'harness-tools',
          version: '1.0.0',
          tools: [
            searchDocsToolClaude,
            readDocToolClaude,
            createSearchCodeToolClaude({ repoRoot: app.repoRoot }),
            createOutlineFileToolClaude({ repoRoot: app.repoRoot }),
            readFileToolClaude,
            readFilesToolClaude,
            createAuditThemeToolClaude({ repoRoot: app.repoRoot }),
            createAnalyzeColorsToolClaude({ repoRoot: app.repoRoot }),
            createProposeThemeToolClaude({ sessionId: session.id, repoRoot: app.repoRoot }),
            createRememberDesignToolClaude({ appId: app.id, sessionId: session.id }),
            createWriteRequirementsToolClaude(docInfo),
            createWritePlanToolClaude({ ...docInfo, requirementsPath }),
            createStartCodingToolClaude({ sessionId: session.id }),
            askMultipleChoiceToolClaude,
            askQuestionToolClaude,
            ...(screenshots ? [createScreenshotToolClaude({ sessionId: session.id, repoRoot: app.repoRoot })] : []),
          ],
        });

      const { sdkSessionId } = await runClaudeAgentTurn({
        systemPrompt,
        createMcpServer,
        toolNames: [...TOOL_NAMES, ...(screenshots ? ['screenshot_app'] : [])],
        model,
        resumeSessionId: session.claudeSessionIds.requirements,
        prompt,
        cwd: app.repoRoot,
        onEvent: wrappedOnEvent,
      });
      await setClaudeSessionId(session.id, 'requirements', sdkSessionId);
    } else {
      const apiKey = await getApiKey(provider);
      if (apiKey === null) {
        const message = `No API key configured for ${provider} — add one in Settings before running the UI/UX agent.`;
        onEvent({ type: 'error', message });
        await appendTranscriptEntry(session.id, 'requirements', { role: 'system', text: message, isError: true });
        return session;
      }
      const { searchDocsTool, readDocTool } = createDocsSearchTools({ appId: app.id, sessionId: session.id });
      const { readFileTool, readFilesTool } = createFileTools({ repoRoot: app.repoRoot });
      const tools: ToolSet = {
        search_docs: searchDocsTool,
        read_doc: readDocTool,
        search_code: createSearchCodeTool({ repoRoot: app.repoRoot }),
        outline_file: createOutlineFileTool({ repoRoot: app.repoRoot }),
        read_file: readFileTool,
        read_files: readFilesTool,
        audit_theme: createAuditThemeTool({ repoRoot: app.repoRoot }),
        analyze_colors: createAnalyzeColorsTool({ repoRoot: app.repoRoot }),
        propose_theme: createProposeThemeTool({ sessionId: session.id, repoRoot: app.repoRoot }),
        remember_design: createRememberDesignTool({ appId: app.id, sessionId: session.id }),
        write_requirements_doc: createWriteRequirementsTool(docInfo),
        write_plan_doc: createWritePlanTool({ ...docInfo, requirementsPath }),
        start_coding: createStartCodingTool({ sessionId: session.id }),
        ask_multiple_choice: askMultipleChoiceTool,
        ask_question: askQuestionTool,
        ...(screenshots ? { screenshot_app: createScreenshotTool({ sessionId: session.id, repoRoot: app.repoRoot }) } : {}),
      };
      const { updatedHistory } = await runAgentTurn({
        systemPrompt,
        tools,
        provider,
        model,
        apiKey,
        history: session.histories.requirements,
        prompt,
        onEvent: wrappedOnEvent,
      });
      await setHistory(session.id, 'requirements', historyWithoutImages(updatedHistory));
    }
  } finally {
    await stopScreenshotServer(session.id);
  }

  return syncDocs(session.id);
}

/** Mirrors the documents the agent wrote (and start_coding may have approved) onto the session. */
async function syncDocs(sessionId: string): Promise<SessionRecord> {
  const session = (await getSession(sessionId)) as SessionRecord;
  const patch: Partial<SessionRecord> = {};
  for (const [dir, pathKey, statusKey] of [
    [config.requirementsDir, 'requirementsPath', 'requirementsStatus'],
    [config.plansDir, 'planPath', 'planStatus'],
  ] as const) {
    const file = path.join(dir, `${session.sessionKey}.md`);
    if (!existsSync(file)) continue;
    patch[pathKey] = path.relative(config.harnessRoot, file);
    const status = matter(await fs.readFile(file, 'utf8')).data.status;
    patch[statusKey] = status === 'draft' || status === 'approved' || status === 'superseded' ? status : (session[statusKey] ?? 'draft');
  }
  return updateSession(sessionId, patch);
}

async function persistEvent(sessionId: string, event: AgentEvent, resultToolName?: string): Promise<void> {
  if (event.type === 'usage') return addStageUsage(sessionId, 'requirements', event);
  if (event.type === 'assistant_text') {
    await appendTranscriptEntry(sessionId, 'requirements', { role: 'assistant', text: event.text });
  } else if (event.type === 'tool_call') {
    await appendTranscriptEntry(sessionId, 'requirements', {
      role: 'tool_call',
      toolCallId: event.toolCallId,
      toolName: event.name,
      toolInput: event.input,
    });
  } else if (event.type === 'tool_result') {
    await appendTranscriptEntry(sessionId, 'requirements', {
      role: 'tool_result',
      toolCallId: event.toolCallId,
      toolName: resultToolName,
      toolResult: event.content,
      isError: event.isError,
    });
  } else if (event.type === 'continuation') {
    await appendTranscriptEntry(sessionId, 'requirements', {
      role: 'system',
      text: `↻ Turn budget reached — continuing automatically (round ${event.hop} of ${event.maxHops}).`,
    });
  }
}
