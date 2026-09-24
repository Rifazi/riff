import type { FastifyInstance } from 'fastify';
import { startEventStream } from './sse.js';
import { getSession, updateSession } from '../sessions/session-store.js';
import { stageGroupFor, type StageGroup } from '../sessions/stage-group.js';
import type { SessionRecord, TranscriptEntry } from '../sessions/session.js';
import { decideNextAction, flattenTranscript, hasUnansweredQuestion } from '../agents/coordinator-agent.js';
import { runRequirementsAgentTurn } from '../agents/requirements-agent.js';
import { runPlanAgentTurn } from '../agents/plan-agent.js';
import { runCodingAgentTurn } from '../agents/coding-agent.js';
import { runQaAgentTurn } from '../agents/qa-agent.js';
import type { AgentEvent } from '../agents/sdk-client.js';

// Hard cap so a stuck/looping coordinator can't run away unattended — it
// always stops and hands back to a human rather than looping forever.
const MAX_ITERATIONS = 15;

// The message that kicks off a stage's very first turn when the coordinator
// finds it with an empty transcript. QA's already exists client-side today
// in QaStage.tsx's own useEffect (unconditional, coordinator or not) —
// duplicated here deliberately rather than shared, since that effect stays
// exactly as-is for non-coordinator sessions.
const KICKOFF_MESSAGE: Partial<Record<StageGroup, string>> = {
  plan: 'Please break the approved requirements into a concrete, reviewable step-by-step plan.',
  coding: 'Please implement the approved plan.',
  qa: 'Please review this branch against the requirements document, run lint and the unit test suite, and write the QA report.',
};

const RUN_TURN: Record<StageGroup, (session: SessionRecord, message: string, onEvent: (e: AgentEvent) => void) => Promise<SessionRecord>> = {
  requirements: runRequirementsAgentTurn,
  plan: runPlanAgentTurn,
  coding: runCodingAgentTurn,
  qa: runQaAgentTurn,
};

function transcriptFor(session: SessionRecord, group: StageGroup): TranscriptEntry[] {
  return session.transcripts[group];
}

export async function registerCoordinatorRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { id: string }; Body: { enabled: boolean } }>('/api/sessions/:id/coordinator/toggle', async (request, reply) => {
    const session = await getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: 'session not found' });
    const { enabled } = request.body ?? {};
    if (typeof enabled !== 'boolean') return reply.code(400).send({ error: 'enabled (boolean) is required' });
    return updateSession(session.id, { coordinatorEnabled: enabled });
  });

  // SSE, same framing as the per-stage /message endpoints — drives the
  // current stage's own agent forward automatically (composing the
  // follow-up messages, deciding when it looks ready) without ever
  // approving/rejecting anything itself. Stops at MAX_ITERATIONS, when
  // coordinatorEnabled is turned off mid-run, or when the decision function
  // says "ready".
  app.post<{ Params: { id: string } }>('/api/sessions/:id/coordinator/run', async (request, reply) => {
    const sessionId = request.params.id;
    const initial = await getSession(sessionId);
    if (!initial) return reply.code(404).send({ error: 'session not found' });

        startEventStream(reply);

    const send = (event: AgentEvent) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    try {
      for (let i = 0; i < MAX_ITERATIONS; i++) {
        const session = await getSession(sessionId);
        if (!session) break;
        if (!session.coordinatorEnabled) {
          send({ type: 'coordinator_decision', action: 'ready', reason: 'Coordinator was turned off.' });
          break;
        }

        const group = stageGroupFor(session);
        const transcript = transcriptFor(session, group);

        let message: string;
        if (transcript.length === 0) {
          const kickoff = KICKOFF_MESSAGE[group];
          if (!kickoff) {
            // requirements: nothing to continue from — the coordinator
            // can't invent a feature request out of nothing.
            send({ type: 'coordinator_decision', action: 'ready', reason: 'Describe the feature you want built first.' });
            break;
          }
          message = kickoff;
        } else if (hasUnansweredQuestion(transcript)) {
          // Don't even ask the LLM — it can't see the question's actual
          // text (flattenTranscript reduces a tool_call to
          // "[called ask_multiple_choice]"), so it has no way to tell this
          // apart from "stalled, safe to nudge" and would just compose a
          // pointless check-in message instead of truly waiting.
          send({ type: 'coordinator_decision', action: 'ready', reason: 'Waiting for the human to answer a pending question.' });
          break;
        } else {
          const decision = await decideNextAction({
            stageLabel: group,
            transcriptText: flattenTranscript(transcript),
            appId: session.appId,
          });
          send({ type: 'coordinator_decision', action: decision.action, reason: decision.reason });
          if (decision.action === 'ready' || !decision.message) break;
          message = decision.message;
        }

        try {
          await RUN_TURN[group](session, message, send);
        } catch (err) {
          send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
          break;
        }

        if (i === MAX_ITERATIONS - 1) {
          send({ type: 'coordinator_decision', action: 'ready', reason: 'Hit the auto-continue limit — stopping for a human to review.' });
        }
      }
    } finally {
      reply.raw.end();
    }
  });
}
