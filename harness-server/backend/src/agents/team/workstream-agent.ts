import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ToolSet } from 'ai';
import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../../config.js';
import type { AppConfig } from '../../apps/apps.js';
import { appendTeamTranscriptEntry, getSession, mutateSession, addStageUsage } from '../../sessions/session-store.js';
import type { CodingTeamMember, SessionRecord } from '../../sessions/session.js';
import { getApiKey, getRoleModelConfig } from '../../settings/settings-store.js';
import { getPromptOverride } from '../../settings/prompts-store.js';
import { themeBriefingFor } from '../../themes/theme-context.js';
import { createAuditThemeTool } from '../tool-defs/theme-audit-tool.js';
import { createAuditThemeToolClaude } from '../tool-defs-claude/theme-audit-tool.js';
import { createClassifyTextTool } from '../helpers/classifier/tool.js';
import { createClassifyTextToolClaude } from '../helpers/classifier/tool-claude.js';
import { runAgentTurn, runClaudeAgentTurn, type AgentEvent, type CompactionOptions } from '../sdk-client.js';
import { buildHandoff, ContextLog, entriesSince } from '../handoff.js';
import { COMPACT_AT_TOKENS, hopLimits, loadApprovedDocsForCoding } from '../coding-agent.js';
import { DELEGATE_NOTE, delegateDeps as researchDeps, delegateToolEntry, noteDelegateRead } from '../helpers/research/tool.js';
import { createDelegateToolClaude } from '../helpers/research/tool-claude.js';
import type { HelperContext } from '../helpers/helper.js';
import { repoInstructionsNote } from '../repo-instructions.js';
import { listSessionReferenceDocs, referenceDocsManifest } from '../../sessions/reference-docs.js';
import { createDocsSearchTools } from '../tool-defs/docs-search-tool.js';
import { createSearchCodeTool } from '../tool-defs/code-search-tool.js';
import { createOutlineFileTool } from '../tool-defs/outline-tool.js';
import { createFileTools } from '../tool-defs/file-tools.js';
import { ReadMemo } from '../tool-defs/read-memo.js';
import { createGitTools } from '../tool-defs/git-tools.js';
import { createQaTools } from '../tool-defs/qa-tools.js';
import { createRunPrettierTool } from '../tool-defs/format-tool.js';
import { createRunNpmInstallTool } from '../tool-defs/npm-install-tool.js';
import { createNoteForQaTool } from '../tool-defs/qa-notes-tool.js';
import { createUpdateMyStepsTool } from '../tool-defs/team-steps-tool.js';
import { createDocsSearchToolsClaude } from '../tool-defs-claude/docs-search-tool.js';
import { createSearchCodeToolClaude } from '../tool-defs-claude/code-search-tool.js';
import { createOutlineFileToolClaude } from '../tool-defs-claude/outline-tool.js';
import { createFileToolsClaude } from '../tool-defs-claude/file-tools.js';
import { createGitToolsClaude } from '../tool-defs-claude/git-tools.js';
import { createQaToolsClaude } from '../tool-defs-claude/qa-tools.js';
import { createRunPrettierToolClaude } from '../tool-defs-claude/format-tool.js';
import { createRunNpmInstallToolClaude } from '../tool-defs-claude/npm-install-tool.js';
import { createNoteForQaToolClaude } from '../tool-defs-claude/qa-notes-tool.js';
import { createUpdateMyStepsToolClaude } from '../tool-defs-claude/team-steps-tool.js';
// No read_file compression here: a team member edits what it reads, and a
// compressed read only sent it back for a ranged re-read (helpers/compress.ts).
import { compressMessages } from '../helpers/compress.js';

const CODING_PROMPT_PATH = path.join(config.harnessRoot, 'backend/src/agents/prompts/coding-agent.md');
const TEAM_PROMPT_PATH = path.join(config.harnessRoot, 'backend/src/agents/prompts/coding-team-member.md');

const noBranchCreation = async () => {
  throw new Error('Team members work on a branch created for them — there is no branch to create.');
};

function ownsPackageJson(member: CodingTeamMember): boolean {
  return member.ownedPaths.includes('package.json');
}

export interface RunWorkstreamParams {
  session: SessionRecord;
  app: AppConfig;
  member: CodingTeamMember;
  teammates: CodingTeamMember[];
  worktreePath: string;
  onEvent: (event: AgentEvent) => void;
  // Light-model routing (see coding-team.ts): run on this model instead of
  // the coding role's, and/or with this message instead of the default.
  model?: string;
  prompt?: string;
  // The human restarted this member (coding-team.ts restartMember): its
  // conversation was cleared, and the restart says so instead of "ran out of steps".
  restarted?: boolean;
  // Aborted when the human restarts a running member. Nothing from the
  // aborted run is persisted after that, so it can't clobber the restart.
  abortSignal?: AbortSignal;
}

/**
 * One coding-team member's run: the normal coding agent's prompt and docs,
 * plus the team rules (coding-team-member.md) and its own workstream brief,
 * with every repo tool rooted at its own worktree and writes limited to the
 * paths it owns. Implements its whole workstream in one turn — nobody
 * reviews between a member's steps.
 */
export async function runWorkstreamAgent({
  session,
  app,
  member,
  teammates,
  worktreePath,
  onEvent,
  model: modelOverride,
  prompt: promptOverride,
  restarted,
  abortSignal,
}: RunWorkstreamParams): Promise<void> {
  const { provider: roleProvider, model: roleModel, delegateModel } = await getRoleModelConfig('coding');
  // When the member carries a localModel, spin it up on Ollama instead of the
  // cloud coding model — the lead set this via assign_team based on the
  // settings.ts localTeamModel setting.
  const provider = member.localModel ? 'ollama' : roleProvider;
  const model = member.localModel ?? modelOverride ?? roleModel;
  // Local helpers (helpers/) report into this member's own chat.
  const helperContext: HelperContext = {
    sessionId: session.id,
    stage: 'coding',
    record: (entry) => appendTeamTranscriptEntry(session.id, member.id, entry),
  };
  const delegateDeps = researchDeps({
    model: provider === 'ollama' ? null : delegateModel,
    repoRoot: worktreePath,
    appId: app.id,
    context: helperContext,
    checkCommands: app.checkCommands,
  });
  const base = (await getPromptOverride(app.id, 'coding')) ?? (await fs.readFile(CODING_PROMPT_PATH, 'utf8'));
  const teamRules = await fs.readFile(TEAM_PROMPT_PATH, 'utf8');
  const { text: approvedDocs, planSteps } = await loadApprovedDocsForCoding(session, worktreePath, member.stepIds);

  // Steps the lead added after the plan (e.g. QA fixes) carry a brief.
  const stepLine = (id: string) => {
    const step = session.codingPlan?.find((s) => s.id === id);
    const title = step?.title ?? planSteps.find((s) => s.id === id)?.title ?? id;
    return `- id: "${id}", title: "${title}"${step?.brief ? `\n  ${step.brief.replace(/\n/g, '\n  ')}` : ''}`;
  };
  const kind = session.codingTeam?.kind ?? 'plan';
  const roundNote =
    kind === 'plan'
      ? ''
      : `This round isn't building the approved plan: ${kind === 'qa-fix' ? 'QA reviewed the merged branch and sent it back' : 'the human asked for more work on the branch'}, and the lead split it across the team. Your steps' briefs say what to change. The plan above is context for what the feature is.\n\n`;
  const others = teammates
    .filter((t) => t.id !== member.id)
    .map(
      (t) =>
        `- ${t.title} (${t.id}) owns ${t.ownedPaths.join(', ')}${member.dependsOn.includes(t.id) ? ' — already merged into your branch' : ''}`,
    )
    .join('\n');
  const brief =
    `\n\n${teamRules}\n\n# Your workstream: ${member.title} (${member.id})\n\n${roundNote}` +
    `Your branch: ${member.branch}\n\nYour steps, in order:\n${member.stepIds.map(stepLine).join('\n')}\n\n` +
    `Your owned paths (the only places you can write):\n${member.ownedPaths.map((p) => `- ${p}`).join('\n')}\n\n` +
    `Your teammates (don't write their paths):\n${others || '- (none)'}`;
  const referenceDocs = referenceDocsManifest(await listSessionReferenceDocs(session));
  const systemPrompt =
    base +
    (delegateDeps ? DELEGATE_NOTE : '') +
    themeBriefingFor(worktreePath, 'coding') +
    repoInstructionsNote(worktreePath) +
    approvedDocs +
    brief +
    (referenceDocs ? `\n\n${referenceDocs}` : '');

  const resuming = member.transcript.length > 0;
  // A failed member's history is cleared before re-run (coding-team.ts) so it
  // doesn't replay the same exhausted context. Detect that here: transcript
  // exists (we've run before) but no conversation state remains.
  const hasContext = provider === 'claude' ? Boolean(member.claudeSessionId) : member.history.length > 0;
  const freshAfterFailure = resuming && !hasContext;

  let handoffNote = '';
  let contextStartEntryId = member.contextStartEntryId ?? null;
  if (freshAfterFailure) {
    handoffNote = await buildHandoff({
      reason: restarted ? 'The human stopped the previous run and restarted it fresh.' : 'The previous run ran out of steps and was restarted fresh.',
      entries: entriesSince(member.transcript, contextStartEntryId),
      repoRoot: worktreePath,
      branch: member.branch,
      baseBranch: session.branch ?? undefined,
      checklist: (session.codingPlan ?? []).filter((s) => member.stepIds.includes(s.id)),
    });
    const marker = await appendTeamTranscriptEntry(session.id, member.id, {
      role: 'system',
      text: restarted
        ? '⟲ New conversation — restarted by you, continuing from a handoff summary.'
        : '⟲ New conversation — previous run ran out of steps, restarting with a handoff summary.',
    });
    contextStartEntryId = marker.id;
    await mutateSession(session.id, (s) => {
      const m = s.codingTeam?.members.find((x) => x.id === member.id);
      if (m) m.contextStartEntryId = marker.id;
    });
  }

  const feedback = member.feedback
    ? `Your lead reviewed your branch and sent it back:\n\n${member.feedback}\n\nYour checkout has everything you ` +
      'committed. Make exactly these changes, keep lint and tests passing, commit, and leave nothing uncommitted. ' +
      'Your branch goes back to the lead for review when you finish.'
    : null;
  const prompt =
    promptOverride ??
    feedback ??
    (freshAfterFailure
      ? `Your previous run on this workstream ${restarted ? 'was stopped and restarted' : 'ran out of steps'}. The summary above shows what was done. ` +
        'Check what is already committed on your branch (and anything left uncommitted in your checkout), then finish ' +
        'any remaining steps and leave nothing uncommitted.'
      : resuming
        ? 'Your previous run on this workstream stopped before it finished. Your checkout still has everything you ' +
          'committed (and anything you left uncommitted). Read your files to see where you got to, then finish the ' +
          'remaining steps and leave nothing uncommitted.'
        : `Implement your workstream "${member.title}" now: all of your steps, in order, then summarize.`);

  const fullPrompt = handoffNote ? `${handoffNote}\n\n---\n\n${prompt}` : prompt;

  await appendTeamTranscriptEntry(session.id, member.id, { role: 'user', text: fullPrompt });

  // A workstream runs as one long turn, so it compacts at continuation hops
  // (agents/handoff.ts) rather than re-sending every earlier step.
  const contextLog = new ContextLog([
    ...entriesSince(member.transcript, contextStartEntryId),
    { role: 'user', text: fullPrompt },
  ]);
  // read_file/read_doc's repeat notes describe this conversation only, so
  // compaction's fresh one starts with an empty memo.
  const readMemo = new ReadMemo();
  const compaction: CompactionOptions = {
    atTokens: COMPACT_AT_TOKENS,
    ...hopLimits(provider),
    handoff: async () => {
      const latest = await getSession(session.id);
      const handoff = await buildHandoff({
        reason: 'Your workstream conversation reached its tool-call budget and had grown large.',
        entries: contextLog.entries,
        repoRoot: worktreePath,
        branch: member.branch,
        baseBranch: session.branch ?? undefined,
        checklist: (latest?.codingPlan ?? []).filter((s) => member.stepIds.includes(s.id)),
      });
      contextLog.reset();
      readMemo.clear();
      const marker = await appendTeamTranscriptEntry(session.id, member.id, {
        role: 'system',
        text: '⟲ New conversation — this one had grown large, so it was summarized into a handoff note to save tokens.',
      });
      await mutateSession(session.id, (s) => {
        const m = s.codingTeam?.members.find((x) => x.id === member.id);
        if (m) m.contextStartEntryId = marker.id;
      });
      return { prompt: handoff };
    },
  };

  // Each result's tool, so the chat can show a delegate result as its own card.
  const toolNames = new Map<string, string>();
  // A run that ends in an error (out of usage, a provider outage) is a
  // failure with that reason, not "finished without committing anything".
  let runError: string | null = null;
  let lastText = '';
  const wrappedOnEvent = (event: AgentEvent) => {
    if (abortSignal?.aborted) return;
    if (event.type === 'error') runError = event.message;
    if (event.type === 'assistant_text') lastText = event.text;
    if (event.type === 'done' && event.isError) runError ??= event.text || lastText || 'The run ended with an error.';
    contextLog.record(event);
    onEvent(event);
    if (event.type === 'tool_call') toolNames.set(event.toolCallId, event.name);
    void persistEvent(session.id, member.id, event, event.type === 'tool_result' ? toolNames.get(event.toolCallId) : undefined);
  };

  const scoped = { repoRoot: worktreePath, writablePaths: member.ownedPaths };
  const steps = { sessionId: session.id, stepIds: member.stepIds };
  const qaNoteDeps = { sessionId: session.id, from: member.title };

  if (provider === 'claude') {
    const { searchDocsToolClaude, readDocToolClaude } = createDocsSearchToolsClaude({
      appId: app.id,
      sessionId: session.id,
      repoRoot: worktreePath,
      readMemo,
    });
    const { readFileToolClaude, writeFileToolClaude, editFileToolClaude, deleteFileToolClaude } = createFileToolsClaude({
      ...scoped,
      onRead: (filePath) => noteDelegateRead(delegateDeps, filePath),
      readMemo,
    });
    const { gitCommitTool } = createGitToolsClaude({ ...scoped, onBranchCreated: noBranchCreation });
    const { runCheckedCommandToolClaude } = createQaToolsClaude({
      repoRoot: worktreePath,
      checkCommands: app.checkCommands,
      helperContext,
    });
    const tools = [
      searchDocsToolClaude,
      readDocToolClaude,
      createSearchCodeToolClaude({ repoRoot: worktreePath }),
      createOutlineFileToolClaude({ repoRoot: worktreePath }),
      createAuditThemeToolClaude({ repoRoot: worktreePath }),
      createClassifyTextToolClaude(helperContext),
      readFileToolClaude,
      writeFileToolClaude,
      editFileToolClaude,
      deleteFileToolClaude,
      gitCommitTool,
      runCheckedCommandToolClaude,
      createRunPrettierToolClaude(scoped),
      createUpdateMyStepsToolClaude(steps),
      createNoteForQaToolClaude(qaNoteDeps),
      ...(ownsPackageJson(member) ? [createRunNpmInstallToolClaude({ repoRoot: worktreePath })] : []),
      ...(delegateDeps ? [createDelegateToolClaude(delegateDeps)] : []),
    ];
    const toolNames = [
      'search_docs',
      'read_doc',
      'search_code',
      'audit_theme',
      'classify_text',
      'read_file',
      'outline_file',
      'write_file',
      'edit_file',
      'delete_file',
      'git_commit',
      'run_checked_command',
      'run_prettier',
      'update_my_steps',
      'note_for_qa',
      ...(ownsPackageJson(member) ? ['run_npm_install'] : []),
      ...(delegateDeps ? ['delegate'] : []),
    ];

    const { sdkSessionId } = await runClaudeAgentTurn({
      systemPrompt,
      createMcpServer: () => createSdkMcpServer({ name: 'harness-tools', version: '1.0.0', tools }),
      toolNames,
      model,
      resumeSessionId: member.claudeSessionId,
      prompt: fullPrompt,
      cwd: worktreePath,
      onEvent: wrappedOnEvent,
      compaction,
      abortSignal,
    });
    if (abortSignal?.aborted) return;
    await mutateSession(session.id, (s) => {
      const m = s.codingTeam?.members.find((x) => x.id === member.id);
      if (m) m.claudeSessionId = sdkSessionId;
    });
    if (runError) throw new Error(firstLine(runError));
    return;
  }

  const apiKey = await getApiKey(provider);
  if (apiKey === null) throw new Error(`No API key configured for ${provider} — add one in Settings.`);

  const { searchDocsTool, readDocTool } = createDocsSearchTools({
    appId: app.id,
    sessionId: session.id,
    repoRoot: worktreePath,
    readMemo,
  });
  const { readFileTool, writeFileTool, editFileTool, deleteFileTool } = createFileTools({
    ...scoped,
    onRead: (filePath) => noteDelegateRead(delegateDeps, filePath),
    readMemo,
  });
  const { gitCommitTool } = createGitTools({ ...scoped, onBranchCreated: noBranchCreation });
  const { runCheckedCommandTool } = createQaTools({ repoRoot: worktreePath, checkCommands: app.checkCommands, helperContext });
  const tools: ToolSet = {
    search_docs: searchDocsTool,
    read_doc: readDocTool,
    search_code: createSearchCodeTool({ repoRoot: worktreePath }),
    outline_file: createOutlineFileTool({ repoRoot: worktreePath }),
    audit_theme: createAuditThemeTool({ repoRoot: worktreePath }),
    classify_text: createClassifyTextTool(helperContext),
    read_file: readFileTool,
    write_file: writeFileTool,
    edit_file: editFileTool,
    delete_file: deleteFileTool,
    git_commit: gitCommitTool,
    run_checked_command: runCheckedCommandTool,
    run_prettier: createRunPrettierTool(scoped),
    update_my_steps: createUpdateMyStepsTool(steps),
    note_for_qa: createNoteForQaTool(qaNoteDeps),
    ...(ownsPackageJson(member) ? { run_npm_install: createRunNpmInstallTool({ repoRoot: worktreePath }) } : {}),
    ...delegateToolEntry(delegateDeps, member.history),
  };

  const { updatedHistory } = await runAgentTurn({
    systemPrompt,
    tools,
    provider,
    model,
    apiKey,
    history: member.history,
    prompt: fullPrompt,
    onEvent: wrappedOnEvent,
    compaction,
    compressHistory: compressMessages,
    abortSignal,
  });
  if (abortSignal?.aborted) return;
  await mutateSession(session.id, (s) => {
    const m = s.codingTeam?.members.find((x) => x.id === member.id);
    if (m) m.history = updatedHistory;
  });
  if (runError) throw new Error(firstLine(runError));
}

const firstLine = (text: string) => text.trim().split('\n')[0].slice(0, 300);

async function persistEvent(sessionId: string, memberId: string, event: AgentEvent, resultToolName?: string): Promise<void> {
  if (event.type === 'usage') return addStageUsage(sessionId, 'coding', event.usage, event.toolOutput);
  if (event.type === 'assistant_text') {
    await appendTeamTranscriptEntry(sessionId, memberId, { role: 'assistant', text: event.text });
  } else if (event.type === 'tool_call') {
    await appendTeamTranscriptEntry(sessionId, memberId, {
      role: 'tool_call',
      toolCallId: event.toolCallId,
      toolName: event.name,
      toolInput: event.input,
    });
  } else if (event.type === 'tool_result') {
    await appendTeamTranscriptEntry(sessionId, memberId, {
      role: 'tool_result',
      toolCallId: event.toolCallId,
      toolName: resultToolName,
      toolResult: event.content,
      isError: event.isError,
    });
  } else if (event.type === 'continuation') {
    await appendTeamTranscriptEntry(sessionId, memberId, {
      role: 'system',
      text: `↻ Turn budget reached — continuing automatically (round ${event.hop} of ${event.maxHops}).`,
    });
  }
}
