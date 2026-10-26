import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ToolSet } from 'ai';
import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../config.js';
import type { AppConfig } from '../apps/apps.js';
import { getApiKey, getRoleModelConfig } from '../settings/settings-store.js';
import { addStageUsage, appendTranscriptEntry, updateSession } from '../sessions/session-store.js';
import type { SessionRecord, VisualReview } from '../sessions/session.js';
import { diffBaseFor } from '../sessions/shared-branch.js';
import { branchChanges, diffStatAgainstBase, resolveCommit } from '../repo/git.js';
import { runAgentTurn, runClaudeAgentTurn, type AgentEvent } from './sdk-client.js';
import { uiuxStylePrompt } from './uiux-prompt.js';
import { createFileTools } from './tool-defs/file-tools.js';
import { createSearchCodeTool } from './tool-defs/code-search-tool.js';
import { createOutlineFileTool } from './tool-defs/outline-tool.js';
import { createAnalyzeColorsTool } from './tool-defs/color-tool.js';
import { createScreenshotTool, findChrome, stopScreenshotServer, withoutImages } from './tool-defs/screenshot-tool.js';
import { createSubmitVisualReviewTool, type VisualReviewSubmission } from './tool-defs/submit-visual-review-tool.js';
import { createFileToolsClaude } from './tool-defs-claude/file-tools.js';
import { createSearchCodeToolClaude } from './tool-defs-claude/code-search-tool.js';
import { createOutlineFileToolClaude } from './tool-defs-claude/outline-tool.js';
import { createAnalyzeColorsToolClaude } from './tool-defs-claude/color-tool.js';
import { createScreenshotToolClaude } from './tool-defs-claude/screenshot-tool.js';
import { createSubmitVisualReviewToolClaude } from './tool-defs-claude/submit-visual-review-tool.js';
import { effectiveVerdict, MAX_AGENT_ROUNDS, previousReviewNote, uiFiles, visualFixMessage } from './visual-review-core.js';

const PROMPT_PATH = path.join(config.harnessRoot, 'backend/src/agents/prompts/visual-review.md');
const TOOL_NAMES = ['search_code', 'outline_file', 'read_file', 'read_files', 'analyze_colors', 'screenshot_app', 'submit_visual_review'];
const MAX_REQUIREMENTS_CHARS = 6000;
const MAX_SHOTS = 8;

export type VisualGateResult =
  // No UI change, the review is off, or it was already approved (or skipped) at this commit.
  | { status: 'clear' }
  // The human has to look: the UI/UX agent is satisfied, or out of rounds.
  | { status: 'awaiting-human'; review: VisualReview }
  // The UI/UX agent found blockers; the coding lead gets `message`.
  | { status: 'changes-needed'; review: VisualReview; message: string };

const running = new Set<string>();

/**
 * The step between the pre-QA checks and QA for a branch that changes the UI:
 * the UI/UX agent screenshots the changed screens and judges them, and a
 * human approves what it passes. `approveCoding` calls it, so no route
 * reaches QA around it. The record is `session.visualReview`.
 */
export async function runVisualGate(session: SessionRecord, app: AppConfig): Promise<VisualGateResult> {
  if (app.visualReview === false || !session.branch) return { status: 'clear' };
  const head = await resolveCommit(app.repoRoot, session.branch);
  const prev = session.visualReview ?? null;
  if (prev?.head === head) {
    if (prev.status === 'approved' || prev.status === 'skipped') return { status: 'clear' };
    if (prev.status === 'awaiting-human') return { status: 'awaiting-human', review: prev };
  }

  const base = diffBaseFor(session, app);
  const changes = await branchChanges(app.repoRoot, base, ':(glob)**/*.md', session.branch);
  const files = changes ? uiFiles(changes.files) : [];
  if (files.length === 0) return { status: 'clear' };

  const skip = async (reason: string): Promise<VisualGateResult> => {
    await updateSession(session.id, { visualReview: blank(head, 'skipped', { summary: reason, reason, agentRounds: prev?.agentRounds ?? 0 }) });
    await note(session.id, `Visual review skipped: ${reason}`);
    return { status: 'clear' };
  };
  const { provider, model } = await getRoleModelConfig('uiux');
  if (provider === 'ollama') return skip('the UI/UX model runs on Ollama, which can’t be assumed to read images. Pick a Claude, OpenAI or Google model for the UI/UX agent in Settings → Dev Agents.');
  if (!findChrome()) return skip('Chrome was not found. Install it or set RIFF_CHROME.');
  if (provider !== 'claude' && (await getApiKey(provider)) === null) return skip(`no API key for ${provider} (Settings → Dev Agents).`);

  if (running.has(session.id)) throw new Error('The visual review is already running for this session.');
  running.add(session.id);
  try {
    await note(session.id, `Visual review: the UI/UX agent is screenshotting the screens this branch changes (${files.length} UI file${files.length === 1 ? '' : 's'}).`);
    const shots: { file: string; text: string }[] = [];
    let submitted: VisualReviewSubmission | null = null;
    let lastError = '';
    const stat = await diffStatAgainstBase(app.repoRoot, session.branch, base).catch(() => '');
    const requirements = session.requirementsPath
      ? (await fs.readFile(path.join(config.harnessRoot, session.requirementsPath), 'utf8').catch(() => '')).slice(0, MAX_REQUIREMENTS_CHARS)
      : '';

    let systemPrompt = await fs.readFile(PROMPT_PATH, 'utf8');
    systemPrompt += await uiuxStylePrompt();
    systemPrompt += previousReviewNote(prev);
    const prompt = [
      `Review the branch \`${session.branch}\` of ${app.name}.`,
      `UI files it changed:\n${files.map((f) => `- ${f}`).join('\n')}`,
      stat ? `Diff stat:\n${stat.trim()}` : '',
      requirements ? `Requirements (what it should look like):\n${requirements}` : '',
    ].filter(Boolean).join('\n\n');

    const onEvent = (event: AgentEvent) => {
      if (event.type === 'usage') void addStageUsage(session.id, 'coding', event, 'uiux-review');
      if (event.type === 'tool_result' && event.isError) lastError = String(typeof event.content === 'string' ? event.content : JSON.stringify(withoutImages(event.content))).slice(0, 400);
    };
    const onCapture = (shot: { file: string; text: string }) => {
      if (shots.length < MAX_SHOTS) shots.push(shot);
    };
    const submit = { onSubmit: (r: VisualReviewSubmission) => void (submitted = r), shotCount: () => shots.length };

    try {
      if (provider === 'claude') {
        const { readFileToolClaude, readFilesToolClaude } = createFileToolsClaude({ repoRoot: app.repoRoot });
        await runClaudeAgentTurn({
          systemPrompt,
          createMcpServer: () =>
            createSdkMcpServer({
              name: 'harness-tools',
              version: '1.0.0',
              tools: [
                createSearchCodeToolClaude({ repoRoot: app.repoRoot }),
                createOutlineFileToolClaude({ repoRoot: app.repoRoot }),
                readFileToolClaude,
                readFilesToolClaude,
                createAnalyzeColorsToolClaude({ repoRoot: app.repoRoot }),
                createScreenshotToolClaude({ sessionId: session.id, repoRoot: app.repoRoot, onCapture }),
                createSubmitVisualReviewToolClaude(submit),
              ],
            }),
          toolNames: TOOL_NAMES,
          model,
          resumeSessionId: null,
          prompt,
          cwd: app.repoRoot,
          onEvent,
        });
      } else {
        const { readFileTool, readFilesTool } = createFileTools({ repoRoot: app.repoRoot });
        const tools: ToolSet = {
          search_code: createSearchCodeTool({ repoRoot: app.repoRoot }),
          outline_file: createOutlineFileTool({ repoRoot: app.repoRoot }),
          read_file: readFileTool,
          read_files: readFilesTool,
          analyze_colors: createAnalyzeColorsTool({ repoRoot: app.repoRoot }),
          screenshot_app: createScreenshotTool({ sessionId: session.id, repoRoot: app.repoRoot, onCapture }),
          submit_visual_review: createSubmitVisualReviewTool(submit),
        };
        await runAgentTurn({ systemPrompt, tools, provider, model, apiKey: (await getApiKey(provider))!, history: [], prompt, onEvent });
      }
    } finally {
      await stopScreenshotServer(session.id);
    }

    if (shots.length === 0) return skip(`no screenshot could be taken${lastError ? ` (${lastError})` : ''}.`);
    const stored = shots.map((s) => ({ file: s.file, label: s.text.replace(/\. Saved to .*$/, '') }));
    // Without a verdict the human still gets the screenshots, and says so.
    const verdictIn = submitted as VisualReviewSubmission | null;
    const findings = verdictIn?.findings ?? [];
    const verdict = verdictIn ? effectiveVerdict(verdictIn.verdict, findings) : null;
    const summary = verdictIn?.summary ?? 'The UI/UX agent took screenshots but did not give a verdict. Judge them yourself.';
    const agentRounds = verdict === 'needs-changes' ? (prev?.agentRounds ?? 0) + 1 : 0;
    const base_ = { head, verdict, summary, findings, shots: stored, agentRounds };

    if (verdict === 'needs-changes' && agentRounds <= MAX_AGENT_ROUNDS) {
      const review = blank(head, 'changes-requested', base_);
      await updateSession(session.id, { visualReview: review });
      await note(session.id, `Visual review: the UI/UX agent wants changes (round ${agentRounds} of ${MAX_AGENT_ROUNDS}). ${summary}`);
      return { status: 'changes-needed', review, message: visualFixMessage(review, 'agent') };
    }
    const review = blank(head, 'awaiting-human', base_);
    await updateSession(session.id, { visualReview: review });
    await note(
      session.id,
      verdict === 'needs-changes'
        ? `Visual review: the UI/UX agent still has concerns after ${MAX_AGENT_ROUNDS} rounds, so the screenshots wait for your decision. ${summary}`
        : `Visual review: the UI/UX agent thinks the screens are good. Screenshots are waiting for your approval. ${summary}`,
    );
    return { status: 'awaiting-human', review };
  } finally {
    running.delete(session.id);
  }
}

function blank(head: string, status: VisualReview['status'], rest: Partial<VisualReview>): VisualReview {
  return { status, head, verdict: null, summary: '', findings: [], shots: [], agentRounds: 0, reviewedAt: new Date().toISOString(), ...rest };
}

async function note(sessionId: string, text: string): Promise<void> {
  await appendTranscriptEntry(sessionId, 'coding', { role: 'system', text });
}
