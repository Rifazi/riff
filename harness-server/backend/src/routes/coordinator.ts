import type { FastifyInstance } from 'fastify';
import { startEventStream } from './sse.js';
import { appendTranscriptEntry, getSession, updateSession } from '../sessions/session-store.js';
import { stageGroupFor, type StageGroup } from '../sessions/stage-group.js';
import type { SessionRecord, TranscriptEntry } from '../sessions/session.js';
import {
  decideGate,
  decideNextAction,
  flattenTranscript,
  hasPendingQuestionTool,
  hasUnansweredQuestion,
  latestChecksFailed,
  concernInLastMessage,
} from '../agents/coordinator-agent.js';
import { runRequirementsAgentTurn } from '../agents/requirements-agent.js';
import { runPlanAgentTurn } from '../agents/plan-agent.js';
import { runCodingAgentTurn } from '../agents/coding-agent.js';
import { runQaAgentTurn } from '../agents/qa-agent.js';
import type { AgentEvent } from '../agents/sdk-client.js';
import { isTeamRunning } from '../agents/team/coding-team.js';
import { isQaTeamRunning } from '../agents/team/qa-team.js';
import { runPreQaGate } from '../agents/pre-qa-gate.js';
import { getApp } from '../apps/apps-store.js';

// Hard cap so a stuck/looping coordinator can't run away unattended — it
// always stops and hands back to a human rather than looping forever.
const MAX_ITERATIONS = 15;

// A branch QA keeps failing needs a human, not another fix pass.
const MAX_QA_SEND_BACKS = 3;

// Fix passes the pre-QA gate asks for before it hands the branch to a human.
const MAX_GATE_SEND_BACKS = 2;

// The message that kicks off a stage's very first turn when the coordinator
// finds it with an empty transcript. QA's already exists client-side in
// QaStage.tsx's own useEffect for sessions without the coordinator.
const KICKOFF_MESSAGE: Partial<Record<StageGroup, string>> = {
  plan: 'Please break the approved requirements into a concrete, reviewable step-by-step plan.',
  coding: 'Please implement the approved plan.',
  qa: 'Please review this branch against the requirements document, run lint and the unit test suite, and write the QA report.',
};

// Keep in sync with QA_RERUN_MESSAGE in QaStage.tsx.
const QA_RERUN_MESSAGE =
  'The coding agent has pushed fixes for your last report. Please re-review the branch against the requirements document, re-run lint and the unit test suite, and write an updated QA report.';
// Keep in sync with QA_TEAM_WRAPUP_MESSAGE in QaStage.tsx.
const QA_TEAM_WRAPUP_MESSAGE = 'Your reviewers have finished. Write the QA report from their findings.';
const NEXT_STEP_MESSAGE = 'Continue with the next step on the checklist.';

const STAGE_DOC: Record<StageGroup, string> = {
  requirements: 'requirements',
  plan: 'plan',
  coding: 'branch',
  qa: 'QA report',
};

const RUN_TURN: Record<StageGroup, (session: SessionRecord, message: string, onEvent: (e: AgentEvent) => void) => Promise<SessionRecord>> = {
  requirements: runRequirementsAgentTurn,
  plan: runPlanAgentTurn,
  // The coordinator only ever drives coding forward step by step, so its
  // turns are step turns — eligible for light-model routing.
  coding: (session, message, onEvent) => runCodingAgentTurn(session, message, onEvent, [], { stepTurn: true }),
  qa: runQaAgentTurn,
};

function transcriptFor(session: SessionRecord, group: StageGroup): TranscriptEntry[] {
  return session.transcripts[group];
}

function stepsDone(session: SessionRecord): number {
  return (session.codingPlan ?? []).filter((s) => s.status === 'done').length;
}

/**
 * Before coding is approved: lint, the unit tests and the branch's
 * Wayfinding audit, with no model involved. Null = approve; `fix` = the lead's
 * next message (failing output only, far cheaper than a QA round that fails
 * on the same thing); `stop` = over to the human.
 */
async function preQaGate(session: SessionRecord, send: (event: AgentEvent) => void): Promise<{ fix: string } | { stop: string } | null> {
  send({ type: 'coordinator_decision', action: 'ready', reason: 'Running lint, the unit tests and the architecture audit before QA.' });
  let gate;
  try {
    gate = await runPreQaGate(session, await getApp(session.appId));
  } catch (err) {
    // A broken gate mustn't hold the branch back: QA runs the same checks.
    await appendTranscriptEntry(session.id, 'coding', { role: 'system', text: `Pre-QA checks couldn't run (${err instanceof Error ? err.message : String(err)}); QA will run them.` });
    return null;
  }
  if (gate.status !== 'fail') {
    if (gate.status === 'skipped') {
      await appendTranscriptEntry(session.id, 'coding', { role: 'system', text: `Pre-QA checks skipped: ${gate.summary}. QA will run them.` });
    }
    return null;
  }
  if (session.coordinatorGateSendBacks >= MAX_GATE_SEND_BACKS) {
    return { stop: `Pre-QA checks still fail after ${MAX_GATE_SEND_BACKS} fix passes (${gate.summary}) — over to you.` };
  }
  await updateSession(session.id, { coordinatorGateSendBacks: session.coordinatorGateSendBacks + 1 });
  send({ type: 'coordinator_decision', action: 'continue', reason: `Pre-QA checks: ${gate.summary} — sending it back to the coding lead.` });
  return { fix: gate.message };
}

function allStepsDone(session: SessionRecord): boolean {
  return (session.codingPlan ?? []).every((s) => s.status === 'done');
}

const STAGE_NAME: Record<StageGroup, string> = {
  requirements: 'the requirements',
  plan: 'the plan',
  coding: 'the diff',
  qa: 'the QA report',
};

type StageOutcome = { approved: true; reason: string } | { approved: false; reason: string };

/**
 * Approves a finished stage the way the human's button would: through the
 * stage's own approve route, so every check it makes (a doc on disk, a
 * split part's dependencies, a branch) still applies. A failing QA report is
 * sent back to coding instead, as the human would.
 */
async function approveStage(app: FastifyInstance, session: SessionRecord, group: StageGroup, why: string): Promise<StageOutcome> {
  let url = `/api/sessions/${session.id}/${group}/approve`;
  let note = `Approved ${STAGE_NAME[group]}: ${why}`;

  if (group === 'qa') {
    if (!session.qaReportPath) return { approved: false, reason: 'QA has not written a report yet.' };
    let result: unknown;
    try {
      result = matter(await fs.readFile(path.join(config.harnessRoot, session.qaReportPath), 'utf8')).data.result;
    } catch {
      return { approved: false, reason: `Could not read ${session.qaReportPath}.` };
    }
    if (result === 'fail') {
      if (session.coordinatorQaSendBacks >= MAX_QA_SEND_BACKS) {
        return { approved: false, reason: `QA has failed this branch ${MAX_QA_SEND_BACKS} times — over to you.` };
      }
      url = `/api/sessions/${session.id}/qa/send-back`;
      note = 'QA failed this branch — sent it back to coding for fixes.';
    } else if (result !== 'pass' && result !== 'pass-with-notes') {
      return { approved: false, reason: `The QA report has no result I recognise (${String(result)}).` };
    }
  }

  const res = await app.inject({ method: 'POST', url, payload: {} });
  if (res.statusCode !== 200) {
    let error = res.body;
    try {
      error = (JSON.parse(res.body) as { error?: string }).error ?? res.body;
    } catch {
      // not JSON
    }
    return { approved: false, reason: `Could not approve ${STAGE_NAME[group]}: ${error}` };
  }
  if (url.endsWith('/qa/send-back')) {
    await updateSession(session.id, { coordinatorQaSendBacks: session.coordinatorQaSendBacks + 1 });
  }
  await appendTranscriptEntry(session.id, group, { role: 'system', text: `Coordinator: ${note}` });
  return { approved: true, reason: note };
}

export async function registerCoordinatorRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { id: string }; Body: { enabled: boolean } }>('/api/sessions/:id/coordinator/toggle', async (request, reply) => {
    const session = await getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: 'session not found' });
    const { enabled } = request.body ?? {};
    if (typeof enabled !== 'boolean') return reply.code(400).send({ error: 'enabled (boolean) is required' });
    return updateSession(session.id, { coordinatorEnabled: enabled, ...(enabled ? { coordinatorQaSendBacks: 0, coordinatorGateSendBacks: 0 } : {}) });
  });

  // SSE, same framing as the per-stage /message endpoints. Drives the
  // current stage until it's approved (the run then ends, and the next
  // stage's tab starts the next run) or something needs the human.
  app.post<{ Params: { id: string } }>('/api/sessions/:id/coordinator/run', async (request, reply) => {
    const sessionId = request.params.id;
    const initial = await getSession(sessionId);
    if (!initial) return reply.code(404).send({ error: 'session not found' });

    startEventStream(reply);
    const send = (event: AgentEvent) => {
      if (!reply.raw.writableEnded) reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const startGroup = stageGroupFor(initial);
    // What Bridget did stays in the stage's chat, not only in this stream.
    // A stop she already noted (the tab reopened on the same stage) isn't repeated.
    const note = async (group: StageGroup, text: string, isError = false) => {
      const entry = `${PERSONA}: ${text}`;
      const last = (await getSession(sessionId))?.transcripts[group].at(-1);
      if (last?.role === 'system' && last.text === entry) return;
      await appendTranscriptEntry(sessionId, group, { role: 'system', text: entry, ...(isError ? { isError } : {}) });
    };
    const stop = async (group: StageGroup, reason: string) => {
      send({ type: 'coordinator_decision', action: 'ready', reason });
      await note(group, reason);
    };
    const turnedOff = async () => !(await getSession(sessionId))?.coordinatorEnabled;

    // The lead's fix pass for a failed pre-QA gate: a plain coding turn (not
    // a step turn, so never light-routed). False = stop the run.
    const runGateFix = async (session: SessionRecord, message: string): Promise<boolean> => {
      try {
        await runCodingAgentTurn(session, message, send);
        return true;
      } catch (err) {
        send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
        return false;
      }
    };

    try {
      for (let turns = 0; ; ) {
        const session = await getSession(sessionId);
        if (!session) break;
        if (!session.coordinatorEnabled) {
          send({ type: 'coordinator_decision', action: 'ready', reason: 'Coordinator was turned off.' });
          break;
        }
        if (session.stage === 'split' || session.stage === 'abandoned') {
          send({ type: 'coordinator_decision', action: 'ready', reason: 'This session is closed — nothing to drive.' });
          break;
        }
        if (session.delivery && session.delivery.kind !== 'pushed') {
          send({ type: 'coordinator_decision', action: 'ready', reason: `Delivered: ${session.delivery.detail}` });
          break;
        }
        const group = stageGroupFor(session);
        if (group !== startGroup) break;
        if (session.themeProposal) {
          await stop(group, 'Waiting for you to apply or dismiss the proposed theme.');
          break;
        }
        if (session.splitProposal) {
          await stop(group, 'Waiting for you to accept or dismiss the proposed split.');
          break;
        }

        // Team rounds run on their own; Bridget waits for them, starting
        // one herself if its tab isn't open to.
        const team = session.codingTeam;
        if (group === 'coding' && team && (isTeamRunning(sessionId) || ['assigned', 'running', 'interrupted'].includes(team.status))) {
          const problem = await settleTeam(sessionId, 'coding', turnedOff);
          if (problem === 'off') continue;
          if (problem) {
            await stop(group, problem);
            break;
          }
          const gate = await preQaGate(session, send);
          if (gate && 'stop' in gate) {
            send({ type: 'coordinator_decision', action: 'blocked', reason: gate.stop });
            break;
          }
          if (!gate) {
            const outcome = await approveStage(app, session, group, 'the coding team finished every step.');
            send({ type: 'coordinator_decision', action: outcome.approved ? 'approved' : 'blocked', reason: outcome.reason });
            break;
          }
          if (!(await runGateFix(session, gate.fix))) break;
          continue;
        }
        const qaTeam = session.qaTeam;
        if (
          group === 'qa' &&
          !session.qaRerunPending &&
          qaTeam &&
          (isQaTeamRunning(sessionId) || ['assigned', 'running', 'interrupted'].includes(qaTeam.status))
        ) {
          const problem = await settleTeam(sessionId, 'qa', turnedOff);
          if (problem === 'off') continue;
          if (problem) {
            await stop(group, problem);
            break;
          }
          continue;
        }

        const transcript = session.transcripts[group];

        // A finished stage is approved, or stops for the human with why.
        const outcome = await tryAdvance(session, group, transcript);
        if (outcome.kind === 'advanced') {
          send({ type: 'coordinator_decision', action: 'advanced', reason: outcome.reason });
          await note(group, outcome.reason);
          break;
        }
        if (outcome.kind === 'stop') {
          await stop(group, outcome.reason);
          break;
        }

        if (turns >= MAX_TURNS) {
          await stop(group, `Ran ${MAX_TURNS} turns without finishing the ${STAGE_DOC[group]} — stopping for you to look.`);
          break;
        }

        let message: string;
        const steps = session.codingPlan ?? [];
        if (group === 'qa' && session.qaRerunPending) {
          message = QA_RERUN_MESSAGE;
        } else if (group === 'qa' && qaTeam?.status === 'done' && !qaTeam.relayed) {
          message = QA_TEAM_WRAPUP_MESSAGE;
        } else if (transcript.length === 0) {
          const kickoff = KICKOFF_MESSAGE[group];
          if (!kickoff) {
            // requirements: nothing to continue from — the coordinator
            // can't invent a feature request out of nothing.
            send({ type: 'coordinator_decision', action: 'ready', reason: 'Describe the feature you want built first.' });
            break;
          }
          message = kickoff;
        } else if (hasUnansweredQuestion(transcript)) {
          // Checked before asking a model, which can't see the question's
          // text and would answer it on the human's behalf.
          await stop(group, 'Waiting for your answer to the question above.');
          break;
        } else if (group === 'coding' && session.branch && steps.some((s) => s.status !== 'done') && !session.teamDecisionPending) {
          // Steps left and nothing asked: the next one, no model needed.
          message = NEXT_STEP_MESSAGE;
        } else {
          const decision = await decideNextAction({
            stageLabel: group,
            transcriptText: flattenTranscript(transcript),
            appId: session.appId,
          });
          if (decision.action === 'ready' && group === 'coding' && !allStepsDone(session)) {
            // A finished step isn't a finished stage: move on to the next
            // one, unless the last nudge got nowhere.
            if (nudgedAtDone === stepsDone(session)) {
              send({ type: 'coordinator_decision', action: 'blocked', reason: 'The last step made no progress — over to you.' });
              break;
            }
            nudgedAtDone = stepsDone(session);
            send({ type: 'coordinator_decision', action: 'continue', reason: decision.reason });
            message = CODING_CONTINUE_MESSAGE;
          } else if (decision.action === 'ready') {
            send({ type: 'coordinator_decision', action: 'ready', reason: decision.reason });
            if (group === 'coding') {
              const gate = await preQaGate(session, send);
              if (gate && 'stop' in gate) {
                send({ type: 'coordinator_decision', action: 'blocked', reason: gate.stop });
                break;
              }
              if (gate) {
                if (!(await runGateFix(session, gate.fix))) break;
                continue;
              }
            }
            const outcome = await approveStage(app, session, group, decision.reason);
            send({ type: 'coordinator_decision', action: outcome.approved ? 'approved' : 'blocked', reason: outcome.reason });
            break;
          }
          send({ type: 'coordinator_decision', action: 'continue', reason: decision.reason });
          message = decision.message;
        }

        turns++;
        try {
          await RUN_TURN[group](session, message, send);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          send({ type: 'error', message: reason });
          await note(group, `stopped: ${reason}`, true);
          break;
        }
      }
    } finally {
      reply.raw.end();
    }
  });
}
