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
import { docsDirFor } from '../apps/apps.js';
import { diffStatAgainstBase } from '../repo/git.js';
import { applyAttachments, type ParsedAttachment } from './attachments.js';
import { runAgentTurn, runClaudeAgentTurn, type AgentEvent } from './sdk-client.js';
import { createDocsSearchTools } from './tool-defs/docs-search-tool.js';
import { createWriteRequirementsTool } from './tool-defs/write-requirements-tool.js';
import { askMultipleChoiceTool, askQuestionTool } from './tool-defs/ask-question-tool.js';
import { createDocsSearchToolsClaude } from './tool-defs-claude/docs-search-tool.js';
import { createWriteRequirementsToolClaude } from './tool-defs-claude/write-requirements-tool.js';
import { askMultipleChoiceToolClaude, askQuestionToolClaude } from './tool-defs-claude/ask-question-tool.js';

const PROMPT_PATH = path.join(config.harnessRoot, 'backend/src/agents/prompts/requirements-agent.md');
const TOOL_NAMES = [
  'search_docs',
  'read_doc',
  'write_requirements_doc',
  'ask_multiple_choice',
  'ask_question',
];

export async function runRequirementsAgentTurn(
  session: SessionRecord,
  userMessage: string,
  onEvent: (event: AgentEvent) => void,
  attachments: ParsedAttachment[] = []
): Promise<SessionRecord> {
  await appendTranscriptEntry(session.id, 'requirements', { role: 'user', text: userMessage });
  let prompt = await applyAttachments(session.id, 'requirements', userMessage, attachments);

  const app = await getApp(session.appId);
  const { provider, model } = await getRoleModelConfig('requirements');

  const promptTemplate = await fs.readFile(PROMPT_PATH, 'utf8');
  const override = await getPromptOverride(app.id, 'requirements');
  const isFirstTurn =
    provider === 'claude' ? !session.claudeSessionIds.requirements : session.histories.requirements.length === 0;

  let systemPrompt = override ?? promptTemplate;
  if (isFirstTurn) {
    try {
      const manifest = await fs.readFile(path.join(docsDirFor(app), 'README.md'), 'utf8');
      systemPrompt += `\n\n# Docs manifest (docs/README.md)\n\n${manifest}`;
    } catch {
      // docs/README.md missing — proceed without the manifest preamble
    }
  }

  // Coding already has a branch — this conversation is revising
  // requirements for work that's partially built, not designing from
  // scratch. This can only be true once the requirements conversation is
  // already underway (a branch can't exist before requirements/plan were
  // first approved), so it's never the first-ever turn — which means for
  // the "claude" provider this turn resumes an existing SDK session via
  // `resume: sessionId`, and that mechanism does NOT re-apply a new system
  // prompt on resume (it only takes effect when a session is first
  // created). So this has to travel as part of the actual turn prompt
  // instead of systemPrompt, which both engines guarantee delivering on
  // every turn regardless of provider or resume state.
  if (session.branch) {
    let stepsText = 'No coding checklist recorded yet.';
    if (session.codingPlan && session.codingPlan.length > 0) {
      stepsText = session.codingPlan.map((s) => `- [${s.status}] ${s.title}`).join('\n');
    }
    let diffStat = '(unable to read diff stat)';
    try {
      diffStat = (await diffStatAgainstBase(app.repoRoot, session.branch)).trim() || '(no changes yet)';
    } catch {
      // repo/branch not in a readable state — proceed without it
    }
    const contextBlock =
      `# Coding already in progress\n\nThis session's requirements are being revised while coding has already ` +
      `started on branch "${session.branch}". Treat this as a change to something partially built, not a fresh ` +
      `design — reason about what should change and what existing work should be preserved.\n\n` +
      `Coding checklist:\n${stepsText}\n\nDiff stat against master:\n${diffStat}`;
    prompt = `${contextBlock}\n\n---\n\n${prompt}`;
  }

  const wrappedOnEvent = (event: AgentEvent) => {
    onEvent(event);
    void persistEvent(session.id, event);
  };

  if (provider === 'claude') {
    const { searchDocsToolClaude, readDocToolClaude } = createDocsSearchToolsClaude({ appId: app.id });
    const createMcpServer = () =>
      createSdkMcpServer({
        name: 'harness-tools',
        version: '1.0.0',
        tools: [
          searchDocsToolClaude,
          readDocToolClaude,
          createWriteRequirementsToolClaude({ sessionKey: session.sessionKey, sessionId: session.id }),
          askMultipleChoiceToolClaude,
          askQuestionToolClaude,
        ],
      });

    const { sdkSessionId } = await runClaudeAgentTurn({
      systemPrompt,
      createMcpServer,
      toolNames: TOOL_NAMES,
      model,
      resumeSessionId: session.claudeSessionIds.requirements,
      prompt,
      cwd: app.repoRoot,
      onEvent: wrappedOnEvent,
    });

    await setClaudeSessionId(session.id, 'requirements', sdkSessionId);
  } else {
    const apiKey = await getCredential(provider);
    if (!apiKey) {
      const message = `No API key configured for ${provider} — add one in Settings before starting a requirements session.`;
      onEvent({ type: 'error', message });
      await appendTranscriptEntry(session.id, 'requirements', { role: 'system', text: message, isError: true });
      return session;
    }

    const { searchDocsTool, readDocTool } = createDocsSearchTools({ appId: app.id });
    const tools: ToolSet = {
      search_docs: searchDocsTool,
      read_doc: readDocTool,
      write_requirements_doc: createWriteRequirementsTool({ sessionKey: session.sessionKey, sessionId: session.id }),
      ask_multiple_choice: askMultipleChoiceTool,
      ask_question: askQuestionTool,
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

    await setHistory(session.id, 'requirements', updatedHistory);
  }

  const requirementsFilePath = path.join(config.requirementsDir, `${session.sessionKey}.md`);
  const fileExists = existsSync(requirementsFilePath);
  const requirementsPath = fileExists ? path.relative(config.harnessRoot, requirementsFilePath) : session.requirementsPath;

  // write_requirements_doc (tool-defs/write-requirements-tool.ts) always
  // writes status: draft to the file, unconditionally — including when it
  // overwrites a previously-approved doc mid-conversation. Mirror that back
  // onto the session record instead of blindly keeping the old value, or
  // the file and the session disagree about whether it's approved.
  let requirementsStatus = session.requirementsStatus;
  if (fileExists) {
    const fileStatus = matter(await fs.readFile(requirementsFilePath, 'utf8')).data.status;
    if (fileStatus === 'draft' || fileStatus === 'approved' || fileStatus === 'superseded') {
      requirementsStatus = fileStatus;
    } else if (requirementsStatus == null) {
      requirementsStatus = 'draft';
    }
  }

  const patch: Partial<SessionRecord> = { requirementsPath, requirementsStatus };
  // Same rule as the manual-edit PUT endpoint: if the agent just reverted an
  // approved doc back to draft, the stage follows it back too.
  if (session.requirementsStatus === 'approved' && requirementsStatus === 'draft') {
    patch.stage = 'requirements-in-progress';
  }

  return updateSession(session.id, patch);
}

async function persistEvent(sessionId: string, event: AgentEvent): Promise<void> {
  if (event.type === 'assistant_text') {
    await appendTranscriptEntry(sessionId, 'requirements', { role: 'assistant', text: event.text });
  } else if (event.type === 'tool_call') {
    await appendTranscriptEntry(sessionId, 'requirements', {
      role: 'tool_call',
      toolName: event.name,
      toolInput: event.input,
    });
  } else if (event.type === 'tool_result') {
    await appendTranscriptEntry(sessionId, 'requirements', {
      role: 'tool_result',
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
