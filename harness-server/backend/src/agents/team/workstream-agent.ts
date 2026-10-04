import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ToolSet } from 'ai';
import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../../config.js';
import type { AppConfig } from '../../apps/apps.js';
import { appendTeamTranscriptEntry, getSession, mutateSession, addStageUsage } from '../../sessions/session-store.js';
import type { CodingTeamMember, SessionRecord } from '../../sessions/session.js';
import { getCredential, getRoleModelConfig } from '../../settings/settings-store.js';
import { getPromptOverride } from '../../settings/prompts-store.js';
import { themeBriefingFor } from '../../themes/theme-context.js';
import { createAuditThemeTool } from '../tool-defs/theme-audit-tool.js';
import { createAuditThemeToolClaude } from '../tool-defs-claude/theme-audit-tool.js';
import { runAgentTurn, runClaudeAgentTurn, type AgentEvent, type CompactionOptions } from '../sdk-client.js';
import { buildHandoff, ContextLog, entriesSince } from '../handoff.js';
import { COMPACT_AT_TOKENS, HOP_COUNT, HOP_STEPS, loadApprovedDocsForCoding } from '../coding-agent.js';
import { repoInstructionsNote } from '../repo-instructions.js';
import { listSessionReferenceDocs, referenceDocsManifest } from '../../sessions/reference-docs.js';
import { createDocsSearchTools } from '../tool-defs/docs-search-tool.js';
import { createSearchCodeTool } from '../tool-defs/code-search-tool.js';
import { createOutlineFileTool } from '../tool-defs/outline-tool.js';
import { createFileTools } from '../tool-defs/file-tools.js';
import { createGitTools } from '../tool-defs/git-tools.js';
import { createQaTools } from '../tool-defs/qa-tools.js';
import { createRunPrettierTool } from '../tool-defs/format-tool.js';
import { createRunNpmInstallTool } from '../tool-defs/npm-install-tool.js';
import { createUpdateMyStepsTool } from '../tool-defs/team-steps-tool.js';
import { createDocsSearchToolsClaude } from '../tool-defs-claude/docs-search-tool.js';
import { createSearchCodeToolClaude } from '../tool-defs-claude/code-search-tool.js';
import { createOutlineFileToolClaude } from '../tool-defs-claude/outline-tool.js';
import { createFileToolsClaude } from '../tool-defs-claude/file-tools.js';
import { createGitToolsClaude } from '../tool-defs-claude/git-tools.js';
import { createQaToolsClaude } from '../tool-defs-claude/qa-tools.js';
import { createRunPrettierToolClaude } from '../tool-defs-claude/format-tool.js';
import { createRunNpmInstallToolClaude } from '../tool-defs-claude/npm-install-tool.js';
import { createUpdateMyStepsToolClaude } from '../tool-defs-claude/team-steps-tool.js';

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
}: RunWorkstreamParams): Promise<void> {
  const { provider, model: roleModel } = await getRoleModelConfig('coding');
  const model = modelOverride ?? roleModel;
  const base = (await getPromptOverride(app.id, 'coding')) ?? (await fs.readFile(CODING_PROMPT_PATH, 'utf8'));
  const teamRules = await fs.readFile(TEAM_PROMPT_PATH, 'utf8');
  const { text: approvedDocs, planSteps } = await loadApprovedDocsForCoding(session, worktreePath, member.stepIds);

  const stepTitle = (id: string) => planSteps.find((s) => s.id === id)?.title ?? id;
  const others = teammates
    .filter((t) => t.id !== member.id)
    .map((t) => `- ${t.title} (${t.id}) owns ${t.ownedPaths.join(', ')}${member.dependsOn.includes(t.id) ? ' — already merged into your branch' : ''}`)
    .join('\n');
  const brief =
    `\n\n${teamRules}\n\n# Your workstream: ${member.title} (${member.id})\n\n` +
    `Your branch: ${member.branch}\n\nYour steps, in order:\n${member.stepIds.map((id) => `- id: "${id}", title: "${stepTitle(id)}"`).join('\n')}\n\n` +
    `Your owned paths (the only places you can write):\n${member.ownedPaths.map((p) => `- ${p}`).join('\n')}\n\n` +
    `Your teammates (don't write their paths):\n${others || '- (none)'}`;
  const referenceDocs = referenceDocsManifest(await listSessionReferenceDocs(session));
  const systemPrompt =
    base + themeBriefingFor(worktreePath, 'coding') + repoInstructionsNote(worktreePath) + approvedDocs + brief + (referenceDocs ? `\n\n${referenceDocs}` : '');

  const resuming = member.transcript.length > 0;
  const prompt = promptOverride ?? (resuming
    ? 'Your previous run on this workstream stopped before it finished. Your checkout still has everything you ' +
      'committed (and anything you left uncommitted). Read your files to see where you got to, then finish the ' +
      'remaining steps and leave nothing uncommitted.'
    : `Implement your workstream "${member.title}" now: all of your steps, in order, then summarize.`);

  await appendTeamTranscriptEntry(session.id, member.id, { role: 'user', text: prompt });

  // A workstream runs as one long turn, so it compacts at continuation hops
  // (agents/handoff.ts) rather than re-sending every earlier step.
  const contextLog = new ContextLog([
    ...entriesSince(member.transcript, member.contextStartEntryId),
    { role: 'user', text: prompt },
  ]);
  const compaction: CompactionOptions = {
    atTokens: COMPACT_AT_TOKENS,
    stepsPerHop: HOP_STEPS,
    maxHops: HOP_COUNT,
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

  const wrappedOnEvent = (event: AgentEvent) => {
    contextLog.record(event);
    onEvent(event);
    void persistEvent(session.id, member.id, event);
  };

  const scoped = { repoRoot: worktreePath, writablePaths: member.ownedPaths };
  const steps = { sessionId: session.id, stepIds: member.stepIds };

  if (provider === 'claude') {
    const { searchDocsToolClaude, readDocToolClaude } = createDocsSearchToolsClaude({ appId: app.id, sessionId: session.id, repoRoot: worktreePath });
    const { readFileToolClaude, writeFileToolClaude, editFileToolClaude } = createFileToolsClaude(scoped);
    const { gitCommitTool } = createGitToolsClaude({ repoRoot: worktreePath, onBranchCreated: noBranchCreation });
    const { runCheckedCommandToolClaude } = createQaToolsClaude({ repoRoot: worktreePath, checkCommands: app.checkCommands });
    const tools = [
      searchDocsToolClaude,
      readDocToolClaude,
      createSearchCodeToolClaude({ repoRoot: worktreePath }),
      createOutlineFileToolClaude({ repoRoot: worktreePath }),
      createAuditThemeToolClaude({ repoRoot: worktreePath }),
      readFileToolClaude,
      writeFileToolClaude,
      editFileToolClaude,
      gitCommitTool,
      runCheckedCommandToolClaude,
      createRunPrettierToolClaude(scoped),
      createUpdateMyStepsToolClaude(steps),
      ...(ownsPackageJson(member) ? [createRunNpmInstallToolClaude({ repoRoot: worktreePath })] : []),
    ];
    const toolNames = [
      'search_docs',
      'read_doc',
      'search_code',
      'audit_theme',
      'read_file',
      'outline_file',
      'write_file',
      'edit_file',
      'git_commit',
      'run_checked_command',
      'run_prettier',
      'update_my_steps',
      ...(ownsPackageJson(member) ? ['run_npm_install'] : []),
    ];

    const { sdkSessionId } = await runClaudeAgentTurn({
      systemPrompt,
      createMcpServer: () => createSdkMcpServer({ name: 'harness-tools', version: '1.0.0', tools }),
      toolNames,
      model,
      resumeSessionId: member.claudeSessionId,
      prompt,
      cwd: worktreePath,
      onEvent: wrappedOnEvent,
      compaction,
    });
    await mutateSession(session.id, (s) => {
      const m = s.codingTeam?.members.find((x) => x.id === member.id);
      if (m) m.claudeSessionId = sdkSessionId;
    });
    return;
  }

  const apiKey = await getCredential(provider);
  if (!apiKey) throw new Error(`No API key configured for ${provider} — add one in Settings.`);

  const { searchDocsTool, readDocTool } = createDocsSearchTools({ appId: app.id, sessionId: session.id, repoRoot: worktreePath });
  const { readFileTool, writeFileTool, editFileTool } = createFileTools(scoped);
  const { gitCommitTool } = createGitTools({ repoRoot: worktreePath, onBranchCreated: noBranchCreation });
  const { runCheckedCommandTool } = createQaTools({ repoRoot: worktreePath, checkCommands: app.checkCommands });
  const tools: ToolSet = {
    search_docs: searchDocsTool,
    read_doc: readDocTool,
    search_code: createSearchCodeTool({ repoRoot: worktreePath }),
    outline_file: createOutlineFileTool({ repoRoot: worktreePath }),
    audit_theme: createAuditThemeTool({ repoRoot: worktreePath }),
    read_file: readFileTool,
    write_file: writeFileTool,
    edit_file: editFileTool,
    git_commit: gitCommitTool,
    run_checked_command: runCheckedCommandTool,
    run_prettier: createRunPrettierTool(scoped),
    update_my_steps: createUpdateMyStepsTool(steps),
    ...(ownsPackageJson(member) ? { run_npm_install: createRunNpmInstallTool({ repoRoot: worktreePath }) } : {}),
  };

  const { updatedHistory } = await runAgentTurn({
    systemPrompt,
    tools,
    provider,
    model,
    apiKey,
    history: member.history,
    prompt,
    onEvent: wrappedOnEvent,
    compaction,
  });
  await mutateSession(session.id, (s) => {
    const m = s.codingTeam?.members.find((x) => x.id === member.id);
    if (m) m.history = updatedHistory;
  });
}

async function persistEvent(sessionId: string, memberId: string, event: AgentEvent): Promise<void> {
  if (event.type === 'usage') return addStageUsage(sessionId, 'coding', event.usage, event.toolOutput);
  if (event.type === 'assistant_text') {
    await appendTeamTranscriptEntry(sessionId, memberId, { role: 'assistant', text: event.text });
  } else if (event.type === 'tool_call') {
    await appendTeamTranscriptEntry(sessionId, memberId, { role: 'tool_call', toolName: event.name, toolInput: event.input });
  } else if (event.type === 'tool_result') {
    await appendTeamTranscriptEntry(sessionId, memberId, { role: 'tool_result', toolResult: event.content, isError: event.isError });
  } else if (event.type === 'continuation') {
    await appendTeamTranscriptEntry(sessionId, memberId, {
      role: 'system',
      text: `↻ Turn budget reached — continuing automatically (round ${event.hop} of ${event.maxHops}).`,
    });
  }
}
