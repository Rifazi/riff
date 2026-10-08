import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ToolSet } from 'ai';
import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../config.js';
import {
  appendTranscriptEntry,
  setClaudeSessionId,
  setHistory,
  updateSession,
  addStageUsage,
} from '../sessions/session-store.js';
import type { QaTeamState, SessionRecord } from '../sessions/session.js';
import { getApiKey, getRoleModelConfig } from '../settings/settings-store.js';
import { getPromptOverride } from '../settings/prompts-store.js';
import { themeContextForTurn } from '../themes/theme-context.js';
import { createAuditThemeTool } from './tool-defs/theme-audit-tool.js';
import { createAuditThemeToolClaude } from './tool-defs-claude/theme-audit-tool.js';
import { createClassifyTextTool } from './helpers/classifier/tool.js';
import { createClassifyTextToolClaude } from './helpers/classifier/tool-claude.js';
import { delegateToolEntry } from './helpers/research/tool.js';
import { stageHelperContext, type HelperContext } from './helpers/helper.js';
import { tryCompressCode, compressMessages } from './helpers/compress.js';
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
import { repoInstructionsNote } from './repo-instructions.js';
import { createAssignQaTeamTool } from './tool-defs/qa-team-tools.js';
import { createAssignQaTeamToolClaude } from './tool-defs-claude/qa-team-tools.js';
import { formatQaTeamFindings } from './team/qa-review-areas.js';
import type { CheckCommand } from './tool-defs/qa-tools.js';

const PROMPT_PATH = path.join(config.harnessRoot, 'backend/src/agents/prompts/qa-agent.md');
// What QA reads the branch with — shared by the QA lead and its reviewers
// (team/qa-reviewer-agent.ts), none of which can change anything.
export const REVIEW_TOOL_NAMES = [
  'search_docs',
  'read_doc',
  'search_code',
  'audit_theme',
  'classify_text',
  'read_file',
  'outline_file',
  'get_diff',
];
const TOOL_NAMES = [
  ...REVIEW_TOOL_NAMES,
  'run_checked_command',
  'write_qa_report',
  'assign_qa_team',
  'ask_multiple_choice',
  'ask_question',
];

export interface ReviewToolDeps {
  appId: string;
  sessionId: string;
  repoRoot: string;
  baseBranch: string;
  checkCommands?: Partial<Record<CheckCommand, string>>;
  helperContext: HelperContext;
}

/** The read-only review tools (REVIEW_TOOL_NAMES) for either engine. */
export function createReviewTools(deps: ReviewToolDeps) {
  const qaDeps = { repoRoot: deps.repoRoot, baseBranch: deps.baseBranch, checkCommands: deps.checkCommands, helperContext: deps.helperContext };
  return {
    claude: () => {
      const { searchDocsToolClaude, readDocToolClaude } = createDocsSearchToolsClaude({ appId: deps.appId, sessionId: deps.sessionId });
      const { readFileToolClaude } = createFileToolsClaude({ repoRoot: deps.repoRoot, compress: tryCompressCode });
      const { getDiffToolClaude } = createQaToolsClaude(qaDeps);
      return [
        searchDocsToolClaude,
        readDocToolClaude,
        createSearchCodeToolClaude({ repoRoot: deps.repoRoot }),
        createOutlineFileToolClaude({ repoRoot: deps.repoRoot }),
        createAuditThemeToolClaude({ repoRoot: deps.repoRoot }),
        createClassifyTextToolClaude(deps.helperContext),
        readFileToolClaude,
        getDiffToolClaude,
      ];
    },
    aiSdk: (): ToolSet => {
      const { searchDocsTool, readDocTool } = createDocsSearchTools({ appId: deps.appId, sessionId: deps.sessionId });
      const { readFileTool } = createFileTools({ repoRoot: deps.repoRoot, compress: tryCompressCode });
      const { getDiffTool } = createQaTools(qaDeps);
      return {
        search_docs: searchDocsTool,
        read_doc: readDocTool,
        search_code: createSearchCodeTool({ repoRoot: deps.repoRoot }),
        outline_file: createOutlineFileTool({ repoRoot: deps.repoRoot }),
        audit_theme: createAuditThemeTool({ repoRoot: deps.repoRoot }),
        classify_text: createClassifyTextTool(deps.helperContext),
        read_file: readFileTool,
        get_diff: getDiffTool,
      };
    },
  };
}

// Asked on the lead's first turn of a review. The when-to-split criteria live
// in assign_qa_team's description, since an app's prompt override replaces
// the base prompt.
const QA_TEAM_FIRST_TURN_NOTE =
  `\n\n# First: review it yourself, or split it across a QA team?\n\nYou are the QA lead. Before checking the ` +
  `criteria one by one, look at the requirements and get_diff (no path) and decide whether a team of reviewers ` +
  `should check this branch in parallel (assign_qa_team says when that's worth it). If so, call assign_qa_team ` +
  `and end your turn; you write the report from their findings. If not, review it yourself as below.`;

/** What the lead needs to know about the current QA team round. */
function qaTeamSection(team: QaTeamState): string {
  const members = team.members
    .map((m) => `- ${m.title} (${m.id}): ${m.status}${m.note ? ` — ${m.note}` : ''}; ${m.criteria.length} criteria`)
    .join('\n');
  const state =
    team.status === 'assigned'
      ? "You split this review across a team; it hasn't started yet. Calling assign_qa_team again replaces that split."
      : team.status === 'running'
        ? 'Your reviewers are checking the branch now.'
        : 'Your reviewers have finished; their findings are in your messages.';
  return `\n\n# Your QA team (round ${team.round})\n\n${state}\n\nReviewers:\n${members}`;
}
export async function runQaAgentTurn(
  session: SessionRecord,
  userMessage: string,
  onEvent: (event: AgentEvent) => void,
  attachments: ParsedAttachment[] = [],
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
        previousFindings = compactQaFindings(
          await fs.readFile(path.join(config.harnessRoot, session.qaReportPath), 'utf8'),
        );
      } catch {
        // report unreadable — the fresh pass just reviews from scratch
      }
    }
    session.histories.qa = [];
    session.claudeSessionIds.qa = null;
    await setHistory(session.id, 'qa', []);
    await setClaudeSessionId(session.id, 'qa', null);
    // The last pass's team reviewed the pre-fix branch: it becomes history,
    // and the fresh pass decides afresh whether to split.
    const retired = session.qaTeam;
    session.qaTeamHistory = retired ? [...session.qaTeamHistory, retired] : session.qaTeamHistory;
    session.qaTeam = null;
    await updateSession(session.id, { qaRerunPending: false, qaTeam: null, qaTeamHistory: session.qaTeamHistory });
    session.qaRerunPending = false;
  }
  // The team finished since the lead last spoke: hand it every reviewer's
  // findings, once, whoever sent this message.
  const team = session.qaTeam;
  const relayFindings = Boolean(team?.finishedAt) && !team!.relayed;
  if (relayFindings) {
    team!.relayed = true;
    await updateSession(session.id, { qaTeam: team });
  }
  await appendTranscriptEntry(session.id, 'qa', { role: 'user', text: userMessage });
  let prompt = await applyAttachments(session.id, 'qa', userMessage, attachments);
  if (relayFindings) prompt = `${formatQaTeamFindings(team!)}\n\n---\n\n${prompt}`;

  const app = await getApp(session.appId);
  const { provider, model } = await getRoleModelConfig('qa');
  const helperContext = stageHelperContext(session.id, 'qa');

  const promptTemplate = await fs.readFile(PROMPT_PATH, 'utf8');
  const override = await getPromptOverride(app.id, 'qa');
  const isFirstTurn = provider === 'claude' ? !session.claudeSessionIds.qa : session.histories.qa.length === 0;

  let systemPrompt = override ?? promptTemplate;
  const themeContext = await themeContextForTurn(session, 'qa', app.repoRoot, isFirstTurn);
  systemPrompt += themeContext.system;
  prompt = themeContext.turnPrefix + prompt;
  if (isFirstTurn) {
    systemPrompt += repoInstructionsNote(app.repoRoot);
    const requirementsRaw = await fs.readFile(path.join(config.harnessRoot, session.requirementsPath), 'utf8');
    systemPrompt += `\n\n# Approved requirements document (${session.requirementsPath})\n\n${requirementsRaw}`;
    systemPrompt += `\n\n# Session\n\nBranch to review: ${session.branch}`;
    if (previousFindings) {
      systemPrompt +=
        `\n\n# Your previous QA pass on this branch\n\nThe coding agent has since pushed fixes for these. Confirm ` +
        `each one is actually resolved, but still do the full review above — every acceptance criterion, lint ` +
        `and tests — since the fixes may have broken something else.\n\n${previousFindings}`;
    }
    if (!session.qaTeam) systemPrompt += QA_TEAM_FIRST_TURN_NOTE;
  }
  if (session.qaTeam) systemPrompt += qaTeamSection(session.qaTeam);

  // What the human has already provided, so the agent reads it instead of
  // asking for it again (see sessions/reference-docs.ts).
  const referenceNote = await referenceDocsTurnNote(session, 'qa', isFirstTurn);
  if (referenceNote) prompt = `${referenceNote}\n\n---\n\n${prompt}`;

  // Each result's tool, so the chat can show a helper's result as its own card.
  const toolNames = new Map<string, string>();
  const wrappedOnEvent = (event: AgentEvent) => {
    onEvent(event);
    if (event.type === 'tool_call') toolNames.set(event.toolCallId, event.name);
    void persistEvent(session.id, event, event.type === 'tool_result' ? toolNames.get(event.toolCallId) : undefined);
  };

  const reviewTools = createReviewTools({
    appId: app.id,
    sessionId: session.id,
    repoRoot: app.repoRoot,
    baseBranch: baseBranchFor(app),
    checkCommands: app.checkCommands,
    helperContext,
  });
  const reportInfo = { sessionKey: session.sessionKey, sessionId: session.id, branch, requirementsPath };
  const checkDeps = { repoRoot: app.repoRoot, baseBranch: baseBranchFor(app), checkCommands: app.checkCommands, helperContext };

  if (provider === 'claude') {
    const tools = [
      ...reviewTools.claude(),
      createQaToolsClaude(checkDeps).runCheckedCommandToolClaude,
      createWriteQaReportToolClaude(reportInfo),
      createAssignQaTeamToolClaude({ sessionId: session.id }),
      askMultipleChoiceToolClaude,
      askQuestionToolClaude,
    ];
    const createMcpServer = () => createSdkMcpServer({ name: 'harness-tools', version: '1.0.0', tools });

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
    const apiKey = await getApiKey(provider);
    if (apiKey === null) {
      const message = `No API key configured for ${provider} — add one in Settings before starting QA.`;
      onEvent({ type: 'error', message });
      await appendTranscriptEntry(session.id, 'qa', { role: 'system', text: message, isError: true });
      return session;
    }

    const tools: ToolSet = {
      ...reviewTools.aiSdk(),
      // QA has no delegate: it re-checked every helper answer itself, so the
      // calls only added time. The stub keeps older histories that called it valid.
      ...delegateToolEntry(null, session.histories.qa),
      run_checked_command: createQaTools(checkDeps).runCheckedCommandTool,
      write_qa_report: createWriteQaReportTool(reportInfo),
      assign_qa_team: createAssignQaTeamTool({ sessionId: session.id }),
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
      compressHistory: compressMessages,
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

async function persistEvent(sessionId: string, event: AgentEvent, resultToolName?: string): Promise<void> {
  if (event.type === 'usage') return addStageUsage(sessionId, 'qa', event.usage, event.toolOutput);
  if (event.type === 'assistant_text') {
    await appendTranscriptEntry(sessionId, 'qa', { role: 'assistant', text: event.text });
  } else if (event.type === 'tool_call') {
    await appendTranscriptEntry(sessionId, 'qa', { role: 'tool_call', toolCallId: event.toolCallId, toolName: event.name, toolInput: event.input });
  } else if (event.type === 'tool_result') {
    await appendTranscriptEntry(sessionId, 'qa', {
      role: 'tool_result',
      toolCallId: event.toolCallId,
      toolName: resultToolName,
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
