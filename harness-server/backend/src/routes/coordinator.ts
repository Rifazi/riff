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
  isFailureWord,
} from '../agents/coordinator-agent.js';
import {
  isSelfHealableBlock,
  isUsageLimitError,
  MAX_FAILED_TURNS,
  MAX_SELF_HEALS,
  SELF_HEAL_MESSAGE,
  usageLimitStopReason,
} from '../agents/agent-failure.js';
import { runRequirementsAgentTurn } from '../agents/requirements-agent.js';
import { runPlanAgentTurn } from '../agents/plan-agent.js';
import { runCodingAgentTurn } from '../agents/coding-agent.js';
import { runQaAgentTurn } from '../agents/qa-agent.js';
import type { AgentEvent } from '../agents/sdk-client.js';
import { isTeamRunning, runCodingTeam } from '../agents/team/coding-team.js';
import { isQaTeamRunning, runQaTeam } from '../agents/team/qa-team.js';
import { runPreQaGate } from '../agents/pre-qa-gate.js';
import { gateStopReason, gateStuck } from '../agents/pre-qa-gate-core.js';
import { getApp } from '../apps/apps-store.js';
import {
  approveCoding,
  approvePlan,
  approveQa,
  approveRequirements,
  deliverSession,
  sendBackToCoding,
  keepSessionOnBranch,
  planDelivery,
  readQaResult,
} from '../sessions/stage-actions.js';
import { shouldKeepOnBranch } from '../sessions/shared-branch.js';
import { loopStopReason, qaReportIsCurrent } from '../sessions/qa-loop.js';
import { qaLoopFor } from '../sessions/qa-rounds.js';

// Bridget, the coordinator, drives a session from requirements to a merge
// request. Within a stage she keeps its agent going; once the stage's
// deliverable is finished she approves it herself unless something needs
// the human: a question, an issue the agent raises (decideGate), pre-QA
// checks that still fail after MAX_GATE_SEND_BACKS fix passes, a proposed
// split or theme, a team that needs attention, any QA result but
// a clean pass, or a repo with no remote (shipping would merge into the
// base branch, which she leaves to the human). Each run drives one stage
// and ends when it advances; the stage tabs start the next run.

// Agent turns per run, so a looping stage can't run away unattended.
const MAX_TURNS = 30;
const PERSONA = 'Bridget';
// How long a team round may sit "assigned" for the tab to start it before
// Bridget starts it herself, and how often she checks on a running one.
const TEAM_START_GRACE_MS = 10_000;
const TEAM_POLL_MS = 5_000;
// Fix passes the pre-QA gate asks for before it hands the branch to a human.
const MAX_GATE_SEND_BACKS = 2;
// QA failures in a row Bridget sends back by herself before she stops for the human.
const MAX_QA_SEND_BACKS = 8;

// The message that kicks off a stage's very first turn when the coordinator
// finds it with an empty transcript. QA's already exists client-side in
// QaStage.tsx's own useEffect for sessions without the coordinator.
const KICKOFF_MESSAGE: Partial<Record<StageGroup, string>> = {
  plan: 'Please break the approved requirements into a concrete, reviewable step-by-step plan.',
  coding: 'Please implement the approved plan.',
  qa: 'Please review this branch against the requirements document and write the QA report. Lint and the unit tests already passed.',
};

// Keep in sync with QA_RERUN_MESSAGE in QaStage.tsx.
const QA_RERUN_MESSAGE =
  'The coding agent has pushed fixes for your last report. Please re-review the branch against the requirements document and write an updated QA report. Lint and the unit tests already passed.';
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Outcome = { kind: 'advanced' | 'stop'; reason: string } | { kind: 'not-ready' } | { kind: 'fix'; message: string };

/**
 * Before coding is approved: lint, the unit tests and the branch's
 * Wayfinding audit, with no model involved. Null = go on to approve; `fix` =
 * the lead's next message (failing output only, far cheaper than a QA round
 * that fails on the same thing); `stop` = over to the human.
 */
async function preQaGate(
  session: SessionRecord,
  send: (event: AgentEvent) => void,
  mustRun?: string,
): Promise<Outcome | null> {
  send({ type: 'coordinator_decision', action: 'continue', reason: 'Running lint, the unit tests and the architecture audit before QA.' });
  let gate;
  try {
    gate = await runPreQaGate(session, await getApp(session.appId));
  } catch (err) {
    // QA doesn't run the checks, so a gate that can't run holds the branch back.
    return { kind: 'stop', reason: mustRun ?? `Lint and the unit tests couldn't be run before QA (${err instanceof Error ? err.message : String(err)}).` };
  }
  if (gate.status === 'skipped') {
    return { kind: 'stop', reason: mustRun ?? `Lint and the unit tests can't be run before QA: ${gate.summary}.` };
  }
  if (gate.status !== 'fail') return null;
  const stuck = gateStuck(session.coordinatorGateLast, gate.fingerprint);
  if (stuck || session.coordinatorGateSendBacks >= MAX_GATE_SEND_BACKS) {
    return { kind: 'stop', reason: gateStopReason(gate.summary, gate.auditProblems, stuck ? 'stuck' : 'limit', session.coordinatorGateSendBacks) };
  }
  await updateSession(session.id, { coordinatorGateSendBacks: session.coordinatorGateSendBacks + 1, coordinatorGateLast: gate.fingerprint });
  send({ type: 'coordinator_decision', action: 'continue', reason: `Pre-QA checks: ${gate.summary}. Sending it back to the coding lead.` });
  return { kind: 'fix', message: gate.message };
}

/**
 * Approves the stage when its deliverable is finished and nothing in it
 * needs the human; says why not otherwise. 'not-ready' = keep driving;
 * 'fix' = the pre-QA gate failed and coding gets a fix pass first.
 */
async function tryAdvance(
  session: SessionRecord,
  group: StageGroup,
  transcript: TranscriptEntry[],
  send: (event: AgentEvent) => void,
): Promise<Outcome> {
  const gate = async (approve: () => Promise<unknown>, approved: string): Promise<Outcome> => {
    if (hasPendingQuestionTool(transcript)) return { kind: 'stop', reason: 'Waiting for your answer to the question above.' };
    const decision = await decideGate({ stageLabel: group, transcriptText: flattenTranscript(transcript) });
    if (decision.action === 'stop') return { kind: 'stop', reason: decision.reason };
    try {
      await approve();
    } catch (err) {
      return { kind: 'stop', reason: err instanceof Error ? err.message : String(err) };
    }
    return { kind: 'advanced', reason: approved };
  };

  switch (group) {
    case 'requirements':
      if (!session.requirementsPath || session.requirementsStatus === 'approved') return { kind: 'not-ready' };
      return gate(() => approveRequirements(session), 'Approved the requirements: nothing in them needs you. On to the plan.');
    case 'plan':
      if (!session.planPath || session.planStatus === 'approved') return { kind: 'not-ready' };
      return gate(() => approvePlan(session), 'Approved the plan: nothing in it needs you. On to coding.');
    case 'coding': {
      const steps = session.codingPlan ?? [];
      const finished =
        Boolean(session.branch) &&
        steps.length > 0 &&
        steps.every((s) => s.status === 'done') &&
        !session.teamDecisionPending &&
        !session.codingReconciliationPending;
      if (!finished) return { kind: 'not-ready' };
      const checks = await preQaGate(session, send);
      if (checks) return checks;
      try {
        await approveCoding(session);
      } catch (err) {
        return { kind: 'stop', reason: err instanceof Error ? err.message : String(err) };
      }
      return { kind: 'advanced', reason: 'Every step is done and lint and the tests pass: sent the branch to QA.' };
    }
    case 'qa':
      return tryShip(session);
  }
}

/** A clean QA pass is marked reviewed and opened as a merge request. Anything else waits for the human. */
async function tryShip(session: SessionRecord): Promise<Outcome> {
  if (session.delivery && session.delivery.kind !== 'pushed') {
    return { kind: 'stop', reason: `Already delivered: ${session.delivery.detail}` };
  }
  if (session.qaStatus !== 'reviewed') {
    // A report from an earlier pass says nothing about this one: the lead
    // writes it up first (the wrap-up message below, for a team pass).
    if (!qaReportIsCurrent(session)) return { kind: 'not-ready' };
    const result = await readQaResult(session);
    if (result === 'fail') {
      // A failed pass goes straight back to the coder; only a runaway stops for the human.
      const loop = await qaLoopFor(session, (await getApp(session.appId)).repoRoot).catch(() => null);
      if (loop && loop.failedInARow >= MAX_QA_SEND_BACKS) {
        return { kind: 'stop', reason: `QA has failed ${loop.failedInARow} passes in a row, so I've stopped sending it back. ${loopStopReason(loop)}` };
      }
      try {
        await sendBackToCoding(session);
      } catch (err) {
        return { kind: 'stop', reason: `QA failed the branch, but sending it back failed: ${err instanceof Error ? err.message : String(err)}` };
      }
      const why = loop?.looping ? ` It keeps coming back (${loop.reasons.join(' ')}), so the coder gets each blocker with why.` : '';
      return { kind: 'advanced', reason: `QA failed the branch (pass ${session.qaPass}). Sent it back to the coder with the findings.${why}` };
    }
    if (result === 'pass-with-notes') {
      return { kind: 'stop', reason: 'QA passed with notes. Decide whether to send them back for fixes or ship as is.' };
    }
    if (result !== 'pass') return { kind: 'not-ready' };
    session = await approveQa(session);
  }
  try {
    // A part of a feature built on one branch stays on it while parts remain; the last one ships them all.
    if (await shouldKeepOnBranch(session)) {
      const kept = await keepSessionOnBranch(session);
      return { kind: 'advanced', reason: `QA passed. ${kept.delivery!.detail}` };
    }
    const plan = await planDelivery(session);
    if (plan.kind === 'merge') {
      return {
        kind: 'stop',
        reason: `QA passed and is marked reviewed. This repo has no remote, so shipping would merge into ${plan.baseBranch} — click Ship when you're ready.`,
      };
    }
    const shipped = await deliverSession(session, plan);
    const d = shipped.delivery!;
    return { kind: 'advanced', reason: `QA passed. ${d.detail}${d.url ? ` ${d.url}` : ''}` };
  } catch (err) {
    return { kind: 'stop', reason: `QA passed, but shipping failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Lets a team round finish: waits while it runs, and starts an assigned or
 * interrupted one if the tab hasn't within TEAM_START_GRACE_MS. Returns
 * null once the round is done, or why it needs the human.
 */
async function settleTeam(
  sessionId: string,
  kind: 'coding' | 'qa',
  shouldStop: () => Promise<boolean>,
): Promise<string | null | 'off'> {
  const running = kind === 'coding' ? isTeamRunning : isQaTeamRunning;
  const run = kind === 'coding' ? runCodingTeam : runQaTeam;
  let waitedToStart = 0;
  for (;;) {
    if (await shouldStop()) return 'off';
    const session = await getSession(sessionId);
    const team = kind === 'coding' ? session?.codingTeam : session?.qaTeam;
    if (!team) return null;
    if (running(sessionId)) {
      await sleep(TEAM_POLL_MS);
      continue;
    }
    if (team.status === 'assigned' || team.status === 'interrupted') {
      if (waitedToStart < TEAM_START_GRACE_MS) {
        waitedToStart += TEAM_POLL_MS;
        await sleep(TEAM_POLL_MS);
        continue;
      }
      // The tab didn't start it (it's closed, or on another stage).
      await run(sessionId, () => {}).catch((err) => {
        if (!running(sessionId)) throw err;
      });
      continue;
    }
    if (team.status === 'needs_attention') {
      const limit = team.members.find((m) => isUsageLimitError(m.note));
      if (limit) return usageLimitStopReason(limit.note!);
      return kind === 'coding'
        ? 'The coding team needs attention: a workstream failed or is waiting on a decision. See the Coding tab.'
        : 'The QA team needs attention: a reviewer failed. See the QA tab.';
    }
    return null;
  }
}

export async function registerCoordinatorRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { id: string }; Body: { enabled: boolean } }>('/api/sessions/:id/coordinator/toggle', async (request, reply) => {
    const session = await getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: 'session not found' });
    const { enabled } = request.body ?? {};
    if (typeof enabled !== 'boolean') return reply.code(400).send({ error: 'enabled (boolean) is required' });
    return updateSession(session.id, { coordinatorEnabled: enabled, ...(enabled ? { coordinatorGateSendBacks: 0, coordinatorGateLast: null } : {}) });
  });

  // A session goes to QA by itself once coding is finished and
  // clean (same checks as auto-drive's coding gate); the human's checkpoint is
  // after QA. Anything off stops here and the Approve button stays theirs.
  app.post<{ Params: { id: string } }>('/api/sessions/:id/coding/auto-handoff', async (request, reply) => {
    const session = await getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: 'session not found' });
    if (!['coding-in-progress', 'coding-review'].includes(session.stage) || session.coordinatorEnabled || session.qaFindingsPending) {
      return { advanced: false, reason: null };
    }
    const outcome = await tryAdvance(session, 'coding', session.transcripts.coding, () => {});
    if (outcome.kind === 'advanced') return { advanced: true, reason: outcome.reason };
    const reason = outcome.kind === 'stop' ? outcome.reason : outcome.kind === 'fix' ? `lint, tests or the audit failed on the branch.\n${outcome.message}` : null;
    if (reason) {
      const text = `Not sent to QA automatically: ${reason}`;
      const last = session.transcripts.coding.at(-1);
      if (!(last?.role === 'system' && last.text === text)) await appendTranscriptEntry(session.id, 'coding', { role: 'system', text });
    }
    return { advanced: false, reason };
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

    try {
      let selfHeals = 0;
      let failedTurns = 0;
      let stepsDone = 0;
      for (let turns = 0; ; ) {
        const session = await getSession(sessionId);
        if (!session) break;
        // The cap is for turns that get nowhere: a long plan finishing a step per turn isn't stuck.
        const doneNow = (session.codingPlan ?? []).filter((s) => s.status === 'done').length;
        if (doneNow > stepsDone) turns = 0;
        stepsDone = doneNow;
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
        const outcome = await tryAdvance(session, group, transcript, send);
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
        let runTurn = RUN_TURN[group];
        const steps = session.codingPlan ?? [];
        if (outcome.kind === 'fix') {
          // The lead's fix pass for a failed pre-QA gate: a plain coding
          // turn (not a step turn, so never light-routed).
          message = outcome.message;
          runTurn = (s, m, onEvent) => runCodingAgentTurn(s, m, onEvent);
        } else if (group === 'qa' && session.qaRerunPending) {
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
          const lastAgentText = [...transcript].reverse().find((e) => e.role === 'assistant')?.text ?? '';
          if (decision.action === 'blocked' && selfHeals < MAX_SELF_HEALS && isSelfHealableBlock(decision.reason, lastAgentText)) {
            // Not finding a file or a setup is the agent's to solve, not the human's.
            selfHeals++;
            send({ type: 'coordinator_decision', action: 'continue', reason: `The agent is stuck on something it can fix itself: ${decision.reason}` });
            await note(group, `the agent said it was stuck (${decision.reason}). That's its to solve, so I've told it to try another way.`);
            message = SELF_HEAL_MESSAGE;
          } else if (decision.action === 'ready' || !decision.message) {
            // Nothing finished to approve, and the agent isn't going on by itself.
            await stop(group, decision.reason || `The ${STAGE_DOC[group]} isn't finished and the agent stopped.`);
            break;
          } else {
            selfHeals = 0;
            send({ type: 'coordinator_decision', action: 'continue', reason: decision.reason });
            message = decision.message;
          }
        }

        turns++;
        // A turn can fail without throwing: the engines report it as an error or an errored done event.
        let turnError: string | null = null;
        const watch = (event: AgentEvent) => {
          if (event.type === 'error') turnError = event.message;
          else if (event.type === 'done' && event.isError) turnError = event.text || turnError || 'The turn ended in an error.';
          send(event);
        };
        try {
          await runTurn(session, message, watch);
        } catch (err) {
          turnError = err instanceof Error ? err.message : String(err);
          send({ type: 'error', message: turnError });
        }
        if (turnError) {
          const failure: string = turnError;
          if (isUsageLimitError(failure)) {
            // Out of tokens: another attempt fails the same way, so stop and say why.
            await stop(group, usageLimitStopReason(failure));
            break;
          }
          if (++failedTurns >= MAX_FAILED_TURNS) {
            await note(group, `stopped after ${failedTurns} failed turns in a row: ${failure}`, true);
            break;
          }
        } else {
          failedTurns = 0;
        }
      }
    } finally {
      reply.raw.end();
    }
  });
}
