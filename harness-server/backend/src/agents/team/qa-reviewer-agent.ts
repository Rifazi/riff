import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ToolSet } from 'ai';
import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../../config.js';
import type { AppConfig } from '../../apps/apps.js';
import { baseBranchFor } from '../../apps/apps.js';
import { addStageUsage, appendTeamTranscriptEntry, mutateSession } from '../../sessions/session-store.js';
import type { QaTeamMember, SessionRecord } from '../../sessions/session.js';
import { getApiKey, getRoleModelConfig } from '../../settings/settings-store.js';
import { getPromptOverride } from '../../settings/prompts-store.js';
import { themeBriefingFor } from '../../themes/theme-context.js';
import { listSessionReferenceDocs, referenceDocsManifest } from '../../sessions/reference-docs.js';
import { runAgentTurn, runClaudeAgentTurn, type AgentEvent } from '../sdk-client.js';
import type { HelperContext } from '../helpers/helper.js';
import { compressMessages } from '../helpers/compress.js';
import { repoInstructionsNote } from '../repo-instructions.js';
import { createReviewTools, REVIEW_TOOL_NAMES } from '../qa-agent.js';
import { createSubmitReviewTool } from '../tool-defs/qa-team-tools.js';
import { qaHandoffSection } from '../tool-defs/qa-notes-tool.js';
import { createSubmitReviewToolClaude } from '../tool-defs-claude/qa-team-tools.js';

const QA_PROMPT_PATH = path.join(config.harnessRoot, 'backend/src/agents/prompts/qa-agent.md');
const REVIEWER_PROMPT_PATH = path.join(config.harnessRoot, 'backend/src/agents/prompts/qa-team-reviewer.md');

export interface RunReviewerParams {
  session: SessionRecord;
  app: AppConfig;
  member: QaTeamMember;
  teammates: QaTeamMember[];
  onEvent: (event: AgentEvent) => void;
  // Aborted when the human restarts a running reviewer; nothing from the
  // aborted run is persisted after that.
  abortSignal?: AbortSignal;
}

/**
 * One QA-team reviewer's run: the normal QA prompt and requirements, plus
 * the reviewer rules (qa-team-reviewer.md) and its own criteria, with the
 * same read-only tools as the QA lead plus submit_review. Reviewers share
 * the main checkout, which nothing writes to during QA.
 */
export async function runQaReviewerAgent({ session, app, member, teammates, onEvent, abortSignal }: RunReviewerParams): Promise<void> {
  if (!session.branch || !session.requirementsPath) throw new Error('QA needs a branch and an approved requirements document.');
  const { provider, model } = await getRoleModelConfig('qa');
  // Local helpers report into this reviewer's own chat.
  const helperContext: HelperContext = {
    sessionId: session.id,
    stage: 'qa',
    record: (entry) => appendTeamTranscriptEntry(session.id, member.id, entry, 'qa'),
  };

  const base = (await getPromptOverride(app.id, 'qa')) ?? (await fs.readFile(QA_PROMPT_PATH, 'utf8'));
  const reviewerRules = await fs.readFile(REVIEWER_PROMPT_PATH, 'utf8');
  const requirements = await fs.readFile(path.join(config.harnessRoot, session.requirementsPath), 'utf8');
  const others = teammates
    .filter((t) => t.id !== member.id)
    .map((t) => `- ${t.title} (${t.id})`)
    .join('\n');
  const brief =
    `\n\n${reviewerRules}\n\n# Your review: ${member.title} (${member.id})\n\n` +
    `Branch to review: ${session.branch}\n\nYour acceptance criteria:\n${member.criteria.map((c) => `- ${c}`).join('\n')}\n\n` +
    (member.focusPaths.length ? `Focus on:\n${member.focusPaths.map((p) => `- ${p}`).join('\n')}\n\n` : '') +
    (member.brief ? `From the QA lead:\n${member.brief}\n\n` : '') +
    `The other reviewers (their criteria aren't yours):\n${others || '- (none)'}`;
  const referenceDocs = referenceDocsManifest(await listSessionReferenceDocs(session));
  const systemPrompt =
    base +
    themeBriefingFor(app.repoRoot, 'qa') +
    repoInstructionsNote(app.repoRoot) +
    `\n\n# Approved requirements document (${session.requirementsPath})\n\n${requirements}` +
    brief +
    qaHandoffSection(session.qaHandoffNotes) +
    (referenceDocs ? `\n\n${referenceDocs}` : '');

  const prompt = `Review your criteria on ${session.branch} now, then call submit_review.`;
  await appendTeamTranscriptEntry(session.id, member.id, { role: 'user', text: prompt }, 'qa');

  const toolNames = new Map<string, string>();
  const wrappedOnEvent = (event: AgentEvent) => {
    if (abortSignal?.aborted) return;
    onEvent(event);
    if (event.type === 'tool_call') toolNames.set(event.toolCallId, event.name);
    void persistEvent(session.id, member.id, event, event.type === 'tool_result' ? toolNames.get(event.toolCallId) : undefined);
  };

  const reviewTools = createReviewTools({
    appId: app.id,
    sessionId: session.id,
    repoRoot: app.repoRoot,
    baseBranch: baseBranchFor(app),
    checkCommands: app.checkCommands,
    helperContext,
  });
  const submit = { sessionId: session.id, memberId: member.id };

  if (provider === 'claude') {
    const tools = [...reviewTools.claude(), createSubmitReviewToolClaude(submit)];
    const { sdkSessionId } = await runClaudeAgentTurn({
      systemPrompt,
      createMcpServer: () => createSdkMcpServer({ name: 'harness-tools', version: '1.0.0', tools }),
      toolNames: [...REVIEW_TOOL_NAMES, 'submit_review'],
      model,
      resumeSessionId: null,
      prompt,
      cwd: app.repoRoot,
      onEvent: wrappedOnEvent,
      abortSignal,
    });
    if (abortSignal?.aborted) return;
    await mutateSession(session.id, (s) => {
      const m = s.qaTeam?.members.find((x) => x.id === member.id);
      if (m) m.claudeSessionId = sdkSessionId;
    });
    return;
  }

  const apiKey = await getApiKey(provider);
  if (apiKey === null) throw new Error(`No API key configured for ${provider} — add one in Settings.`);
  const tools: ToolSet = { ...reviewTools.aiSdk(), submit_review: createSubmitReviewTool(submit) };
  const { updatedHistory } = await runAgentTurn({
    systemPrompt,
    tools,
    provider,
    model,
    apiKey,
    history: [],
    prompt,
    onEvent: wrappedOnEvent,
    compressHistory: compressMessages,
    abortSignal,
  });
  if (abortSignal?.aborted) return;
  await mutateSession(session.id, (s) => {
    const m = s.qaTeam?.members.find((x) => x.id === member.id);
    if (m) m.history = updatedHistory;
  });
}

async function persistEvent(sessionId: string, memberId: string, event: AgentEvent, resultToolName?: string): Promise<void> {
  if (event.type === 'usage') return addStageUsage(sessionId, 'qa', event.usage, event.toolOutput);
  const append = (entry: Parameters<typeof appendTeamTranscriptEntry>[2]) => appendTeamTranscriptEntry(sessionId, memberId, entry, 'qa');
  if (event.type === 'assistant_text') {
    await append({ role: 'assistant', text: event.text });
  } else if (event.type === 'tool_call') {
    await append({ role: 'tool_call', toolCallId: event.toolCallId, toolName: event.name, toolInput: event.input });
  } else if (event.type === 'tool_result') {
    await append({ role: 'tool_result', toolCallId: event.toolCallId, toolName: resultToolName, toolResult: event.content, isError: event.isError });
  } else if (event.type === 'continuation') {
    await append({ role: 'system', text: `↻ Turn budget reached — continuing automatically (round ${event.hop} of ${event.maxHops}).` });
  }
}
