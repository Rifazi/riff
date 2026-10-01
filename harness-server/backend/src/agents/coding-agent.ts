import { promises as fs } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import type { ToolSet } from 'ai';
import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../config.js';
import { appendTranscriptEntry, getSession, setClaudeSessionId, setHistory, updateSession, addStageUsage } from '../sessions/session-store.js';
import type { SessionRecord } from '../sessions/session.js';
import { getCredential, getRoleModelConfig } from '../settings/settings-store.js';
import { getPromptOverride } from '../settings/prompts-store.js';
import { themeBriefingFor, themeContextForTurn } from '../themes/theme-context.js';
import { createAuditThemeTool } from './tool-defs/theme-audit-tool.js';
import { createAuditThemeToolClaude } from './tool-defs-claude/theme-audit-tool.js';
import { getApp } from '../apps/apps-store.js';
import { baseBranchFor } from '../apps/apps.js';
import { applyAttachments, type ParsedAttachment } from './attachments.js';
import { listSessionReferenceDocs, referenceDocsManifest, referenceDocsTurnNote } from '../sessions/reference-docs.js';
import { lightModelFor, nextCodingStepId, planStepEfforts } from './model-routing.js';
import { runAgentTurn, runClaudeAgentTurn, type AgentEvent, type CompactionOptions } from './sdk-client.js';
import { buildHandoff, ContextLog, entriesSince } from './handoff.js';
import { createDocsSearchTools } from './tool-defs/docs-search-tool.js';
import { createSearchCodeTool } from './tool-defs/code-search-tool.js';
import { createOutlineFileTool } from './tool-defs/outline-tool.js';
import { createFileTools } from './tool-defs/file-tools.js';
import { createGitTools } from './tool-defs/git-tools.js';
import { createGenerateTools } from './tool-defs/generate-tools.js';
import { createWriteCodingPlanTool } from './tool-defs/coding-plan-tool.js';
import { createQaTools } from './tool-defs/qa-tools.js';
import { createRunPrettierTool } from './tool-defs/format-tool.js';
import { createRunNpmInstallTool } from './tool-defs/npm-install-tool.js';
import { createDocsSearchToolsClaude } from './tool-defs-claude/docs-search-tool.js';
import { createSearchCodeToolClaude } from './tool-defs-claude/code-search-tool.js';
import { createOutlineFileToolClaude } from './tool-defs-claude/outline-tool.js';
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
  'audit_theme',
  'read_file',
  'outline_file',
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

const ESCALATION_PROMPT = (stepTitle: string, lightModel: string) =>
  `A lighter model (${lightModel}) worked on the step "${stepTitle}" just now but didn't finish it cleanly. ` +
  `Review what it did — its commits on the branch and any uncommitted changes — fix anything that's wrong or ` +
  `missing, then finish the step exactly as the workflow above says (tests, prettier, commit, lint and test, ` +
  `mark it done) and stop.`;

// See SessionRecord.codingContext: a turn starts a fresh conversation when
// the last one ended at or above FRESH_CONTEXT_AT_TOKENS, and a continuation
// hop inside a turn compacts at COMPACT_AT_TOKENS (sdk-client.ts).
const FRESH_CONTEXT_AT_TOKENS = 90_000;
const COMPACT_AT_TOKENS = 110_000;

export interface CodingTurnOptions {
  // An automatic "do the next checklist step" turn (kickoff, Continue,
  // auto-run, coordinator) rather than a human's own message — only these
  // are eligible for the light model, and only these start a fresh
  // conversation at a step boundary.
  stepTurn?: boolean;
  // Relays a QA send-back — always a fresh conversation.
  qaFix?: boolean;
}

export async function runCodingAgentTurn(
  session: SessionRecord,
  userMessage: string,
  onEvent: (event: AgentEvent) => void,
  attachments: ParsedAttachment[] = [],
  options: CodingTurnOptions = {}
): Promise<SessionRecord> {
  const app = await getApp(session.appId);
  const roleConfig = await getRoleModelConfig('coding');
  const { provider, model } = roleConfig;
  const efforts = await planStepEfforts(session);
  const targetStepId = nextCodingStepId(session, efforts);

  // A fresh conversation instead of resuming this one (see
  // SessionRecord.codingContext). Never for a reconciliation, which relies
  // on the agent remembering what it built against the old requirements.
  const hasContext = provider === 'claude' ? Boolean(session.claudeSessionIds.coding) : session.histories.coding.length > 0;
  const ctx = session.codingContext;
  let freshReason: string | null = null;
  if (hasContext && !session.codingReconciliationPending) {
    if (options.qaFix) {
      freshReason = 'QA sent the branch back for fixes, which is a new conversation.';
    } else if (options.stepTurn && targetStepId && ctx?.stepId && targetStepId !== ctx.stepId) {
      freshReason = `The previous conversation covered the step "${ctx.stepId}"; this one starts the next step.`;
    } else if ((ctx?.tokens ?? 0) >= FRESH_CONTEXT_AT_TOKENS) {
      freshReason = 'The previous conversation had grown large.';
    }
  } else if (!hasContext && session.branch && !session.codingTeam) {
    // e.g. the provider was switched — earlier work exists but no conversation does.
    freshReason = 'Earlier conversations already worked on this branch.';
  }

  let contextStartEntryId = ctx?.startEntryId ?? null;
  let handoffNote = '';
  if (freshReason) {
    handoffNote = await buildHandoff({
      reason: freshReason,
      entries: entriesSince(session.transcripts.coding, contextStartEntryId),
      repoRoot: app.repoRoot,
      branch: session.branch,
      baseBranch: baseBranchFor(app),
      checklist: session.codingPlan,
    });
    await setClaudeSessionId(session.id, 'coding', null);
    await setHistory(session.id, 'coding', []);
    session.claudeSessionIds.coding = null;
    session.histories.coding = [];
    const marker = await appendTranscriptEntry(session.id, 'coding', {
      role: 'system',
      text: `⟲ New conversation — ${freshReason} It starts from a handoff note instead of the full history, to save tokens.`,
    });
    contextStartEntryId = marker.id;
  }

  await appendTranscriptEntry(session.id, 'coding', { role: 'user', text: userMessage });
  let prompt = await applyAttachments(session.id, 'coding', userMessage, attachments);

  const promptTemplate = await fs.readFile(PROMPT_PATH, 'utf8');
  const override = await getPromptOverride(app.id, 'coding');
  const basePrompt = override ?? promptTemplate;
  const isFirstTurn = !hasContext || freshReason !== null;

  let systemPrompt = basePrompt;
  const themeContext = await themeContextForTurn(session, 'coding', app.repoRoot, isFirstTurn);
  systemPrompt += themeContext.system;
  prompt = themeContext.turnPrefix + prompt;
  if (isFirstTurn) systemPrompt += await firstTurnSections(session, app.repoRoot);
  if (handoffNote) prompt = `${handoffNote}\n\n---\n\n${prompt}`;

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

  // What the human has already provided, so the agent reads it instead of
  // asking for it again (see sessions/reference-docs.ts).
  const referenceNote = await referenceDocsTurnNote(session, 'coding', isFirstTurn);
  if (referenceNote) prompt = `${referenceNote}\n\n---\n\n${prompt}`;

  const onBranchCreated = async (branchName: string) => {
    await updateSession(session.id, { branch: branchName, stage: 'coding-in-progress' });
  };

  // This conversation's activity, for a handoff if it's compacted mid-turn.
  const contextLog = new ContextLog([
    ...entriesSince((await getSession(session.id))?.transcripts.coding ?? [], contextStartEntryId),
  ]);
  let contextTokens = 0;

  const wrappedOnEvent = (event: AgentEvent) => {
    contextLog.record(event);
    onEvent(event);
    void persistEvent(session.id, event);
  };

  const compaction: CompactionOptions = {
    atTokens: COMPACT_AT_TOKENS,
    handoff: async () => {
      const latest = await getSession(session.id);
      const handoff = await buildHandoff({
        reason: 'The conversation reached its tool-call budget mid-step and had grown large.',
        entries: contextLog.entries,
        repoRoot: app.repoRoot,
        branch: latest?.branch ?? session.branch,
        baseBranch: baseBranchFor(app),
        checklist: latest?.codingPlan ?? session.codingPlan,
      });
      contextLog.reset();
      const marker = await appendTranscriptEntry(session.id, 'coding', {
        role: 'system',
        text: '⟲ New conversation — this one had grown large, so it was summarized into a handoff note to save tokens.',
      });
      contextStartEntryId = marker.id;
      const fresh = latest ?? session;
      const reference = referenceDocsManifest(await listSessionReferenceDocs(fresh));
      return {
        prompt: handoff,
        systemPrompt:
          basePrompt +
          themeBriefingFor(app.repoRoot, 'coding') +
          (await firstTurnSections(fresh, app.repoRoot)) +
          (reference ? `\n\n${reference}` : ''),
      };
    },
  };

  // Light-model routing (agents/model-routing.ts): only for an automatic
  // step turn on a plan step tagged light, never for a human's follow-up,
  // a QA fix or a reconciliation.
  let lightStep: { id: string; title: string; model: string } | null = null;
  const lightModel = lightModelFor(roleConfig);
  if (options.stepTurn && lightModel && !session.codingTeam && !session.codingReconciliationPending) {
    const stepId = targetStepId;
    if (stepId && efforts.get(stepId) === 'light') {
      const title =
        session.codingPlan?.find((s) => s.id === stepId)?.title ??
        (await loadApprovedDocsForCoding(session, app.repoRoot)).planSteps.find((s) => s.id === stepId)?.title ??
        stepId;
      lightStep = { id: stepId, title, model: lightModel };
      await appendTranscriptEntry(session.id, 'coding', {
        role: 'system',
        text: `Light step "${title}" — running on ${lightModel}.`,
      });
    }
  }

  let turnPrompt = prompt;
  let turnModel = lightStep?.model ?? model;
  let result = await runEngine();
  if (lightStep) {
    const after = await getSession(session.id);
    const status = after?.codingPlan?.find((s) => s.id === lightStep.id)?.status;
    if (result.isError || status !== 'done') {
      await appendTranscriptEntry(session.id, 'coding', {
        role: 'system',
        text: `↑ ${lightStep.model} didn't finish "${lightStep.title}" — handing it to ${model}.`,
      });
      if (after) session = after;
      turnPrompt = ESCALATION_PROMPT(lightStep.title, lightStep.model);
      turnModel = model;
      result = await runEngine();
    }
  }

  await updateSession(session.id, {
    codingContext: {
      stepId: freshReason || !ctx ? targetStepId : ctx.stepId,
      startEntryId: contextStartEntryId,
      tokens: contextTokens,
    },
  });

  const latest = await getSession(session.id);
  if (!latest) throw new Error(`Session ${session.id} not found`);
  if (latest.branch && latest.stage === 'coding-in-progress') {
    return updateSession(session.id, { stage: 'coding-review' });
  }
  return latest;

  async function runEngine(): Promise<{ isError: boolean }> {
    if (provider === 'claude') {
      const { searchDocsToolClaude, readDocToolClaude } = createDocsSearchToolsClaude({ appId: app.id, sessionId: session.id });
      const { readFileToolClaude, writeFileToolClaude, editFileToolClaude } = createFileToolsClaude({ repoRoot: app.repoRoot });
      const { gitCreateBranchTool, gitCommitTool } = createGitToolsClaude({ repoRoot: app.repoRoot, baseBranch: baseBranchFor(app), onBranchCreated });
      const { runGeneratePathsToolClaude, runGenerateOpenApiToolClaude } = createGenerateToolsClaude({ repoRoot: app.repoRoot });
      const { runCheckedCommandToolClaude } = createQaToolsClaude({ repoRoot: app.repoRoot, baseBranch: baseBranchFor(app), checkCommands: app.checkCommands });
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

      const { sdkSessionId, isError, contextTokens: tokens } = await runClaudeAgentTurn({
        systemPrompt,
        createMcpServer,
        toolNames: TOOL_NAMES,
        model: turnModel,
        resumeSessionId: session.claudeSessionIds.coding,
        prompt: turnPrompt,
        cwd: app.repoRoot,
        onEvent: wrappedOnEvent,
        compaction,
      });
      contextTokens = tokens;

      await setClaudeSessionId(session.id, 'coding', sdkSessionId);
      session.claudeSessionIds.coding = sdkSessionId;
      return { isError };
    } else {
      const apiKey = await getCredential(provider);
      if (!apiKey) {
        const message = `No API key configured for ${provider} — add one in Settings before starting the coding stage.`;
        onEvent({ type: 'error', message });
        await appendTranscriptEntry(session.id, 'coding', { role: 'system', text: message, isError: true });
        return { isError: true };
      }

      const { searchDocsTool, readDocTool } = createDocsSearchTools({ appId: app.id, sessionId: session.id });
      const { readFileTool, writeFileTool, editFileTool } = createFileTools({ repoRoot: app.repoRoot });
      const { gitCreateBranchTool, gitCommitTool } = createGitTools({ repoRoot: app.repoRoot, baseBranch: baseBranchFor(app), onBranchCreated });
      const { runGeneratePathsTool, runGenerateOpenApiTool } = createGenerateTools({ repoRoot: app.repoRoot });
      const { runCheckedCommandTool } = createQaTools({ repoRoot: app.repoRoot, baseBranch: baseBranchFor(app), checkCommands: app.checkCommands });

      const tools: ToolSet = {
        search_docs: searchDocsTool,
        read_doc: readDocTool,
        search_code: createSearchCodeTool({ repoRoot: app.repoRoot }),
        outline_file: createOutlineFileTool({ repoRoot: app.repoRoot }),
        audit_theme: createAuditThemeTool({ repoRoot: app.repoRoot }),
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

      const { updatedHistory, isError, contextTokens: tokens } = await runAgentTurn({
        systemPrompt,
        tools,
        provider,
        model: turnModel,
        apiKey,
        history: session.histories.coding,
        prompt: turnPrompt,
        onEvent: wrappedOnEvent,
        compaction,
      });
      contextTokens = tokens;

      await setHistory(session.id, 'coding', updatedHistory);
      session.histories.coding = updatedHistory;
      return { isError };
    }
  }
}

/**
 * What a new single-agent coding conversation needs in its system prompt on
 * top of the base prompt and theme: the approved docs, plus how to pick up
 * the branch — the team's merged work, an existing branch (a fresh
 * conversation partway through, see SessionRecord.codingContext), or a
 * brand-new start seeded from the plan's steps.
 */
async function firstTurnSections(session: SessionRecord, repoRoot: string): Promise<string> {
  if (!session.requirementsPath) {
    throw new Error('Cannot start the coding stage without an approved requirements document.');
  }
  if (!session.planPath) {
    throw new Error('Cannot start the coding stage without an approved plan document.');
  }
  const { text: approvedDocs, planSteps } = await loadApprovedDocsForCoding(session, repoRoot);
  let text = approvedDocs;

  if (session.codingTeam) {
    // The team already built the plan on this branch — this agent is the
    // lead handling follow-ups (review feedback, QA fixes), not starting
    // from scratch.
    const checklist = (session.codingPlan ?? []).map((s) => `- id: "${s.id}", status: "${s.status}", title: "${s.title}"`).join('\n');
    const members = session.codingTeam.members
      .map((m) => `- ${m.title} (${m.id}): ${m.status}${m.note ? ` — ${m.note}` : ''}; owned ${m.ownedPaths.join(', ')}`)
      .join('\n');
    text +=
      `\n\n# The coding team already ran\n\nYou are the lead engineer. A team of agents implemented this plan in ` +
      `parallel and their work is merged on branch "${session.branch}", which is checked out. Do NOT call ` +
      `git_create_branch. Review what's there before changing it, handle the human's requests on this branch, and ` +
      `keep the checklist accurate with write_coding_plan.\n\nTeam members:\n${members}\n\nChecklist:\n${checklist}`;
  } else if (session.branch) {
    text +=
      `\n\n# Continuing on an existing branch\n\nThis feature is already in progress on branch "${session.branch}", ` +
      `which is checked out. Do NOT call git_create_branch. The checklist already exists (it's in the message); keep ` +
      `it accurate with write_coding_plan, always passing every step with the same ids.`;
  } else if (planSteps.length > 0) {
    const stepsList = planSteps
      .map((s: { id: string; title: string }) => `- id: "${s.id}", title: "${s.title}"`)
      .join('\n');
    text +=
      `\n\n# Seed for write_coding_plan\n\nYour very first tool call, right after git_create_branch, must ` +
      `be write_coding_plan using exactly these steps (same id and title, do not invent your own) — all ` +
      `status "pending" except the first, which is "in_progress":\n\n${stepsList}`;
  }

  if (!session.codingTeam && !session.branch) text += `\n\n# Session\n\nSuggested branch name: ${suggestedBranchName(session)}`;
  return text;
}

/**
 * The approved requirements doc, the docs it cites and the approved plan,
 * as a system-prompt section — shared by the single coding agent and every
 * coding-team member so they work from identical context.
 */
export async function loadApprovedDocsForCoding(
  session: SessionRecord,
  repoRoot: string
): Promise<{ text: string; planSteps: { id: string; title: string }[] }> {
  if (!session.requirementsPath || !session.planPath) {
    throw new Error('Coding needs an approved requirements document and plan.');
  }
  const requirementsRaw = await fs.readFile(path.join(config.harnessRoot, session.requirementsPath), 'utf8');
  let text = `\n\n# Approved requirements document (${session.requirementsPath})\n\n${requirementsRaw}`;

  const cited: unknown = matter(requirementsRaw).data['related-docs'];
  const relatedDocs: string[] = Array.isArray(cited) ? cited : [];
  // Listed, not inlined: the full docs rode along in every step of every
  // coding (and team-member) turn whether or not they were needed.
  const relatedLines: string[] = [];
  for (const relDoc of relatedDocs) {
    try {
      const docContent = await fs.readFile(path.join(repoRoot, relDoc), 'utf8');
      const heading = /^#+\s+(.+)$/m.exec(docContent)?.[1]?.trim();
      relatedLines.push(`- ${relDoc}${heading ? ` — ${heading}` : ''}`);
    } catch {
      // referenced doc no longer exists — skip it
    }
  }
  if (relatedLines.length > 0) {
    text +=
      `\n\n# Related docs\n\nThe requirements cite these repo docs. Read the ones relevant to your current step ` +
      `with read_file (search_docs finds sections within them):\n\n${relatedLines.join('\n')}`;
  }

  const planRaw = await fs.readFile(path.join(config.harnessRoot, session.planPath), 'utf8');
  text += `\n\n# Approved plan (${session.planPath})\n\n${planRaw}`;
  const steps: unknown = matter(planRaw).data.steps;
  return { text, planSteps: Array.isArray(steps) ? (steps as { id: string; title: string }[]) : [] };
}

export function suggestedBranchName(session: SessionRecord): string {
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
  if (event.type === 'usage') return addStageUsage(sessionId, 'coding', event.usage, event.toolOutput);
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
