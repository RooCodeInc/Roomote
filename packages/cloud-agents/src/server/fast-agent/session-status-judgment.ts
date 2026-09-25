import { redactSecrets } from '@roomote/communication/redact-secrets';
import {
  and,
  claimSessionStatusJudgmentRequests,
  completeSessionStatusJudgment,
  desc,
  db,
  discardPendingSessionStatusJudgments,
  eq,
  fastAgentMessages,
  hasFastConversationPendingUserInput,
  inArray,
  isDeploymentExperimentEnabled,
  isNull,
  retryOrFailSessionStatusJudgment,
  sessionGoals,
  sessionTasks,
  sessions,
  sql,
  taskRuns,
  tasks,
} from '@roomote/db/server';
import {
  ACP_ENVELOPE_EVENT_TYPES,
  SESSION_STATUS_JUDGMENT_OUTCOMES,
  type SessionStatusJudgmentOutcome,
} from '@roomote/types';

import {
  evaluateDecisionModel,
  type TypeSafeChoiceQuestion,
} from '../typesafe-judgment';

const MAX_JUDGMENTS_PER_TICK = 4;
const MAX_CONTEXT_CHARS = 10_000;
const MAX_RECENT_MESSAGES = 8;
const MAX_TASKS = 12;

const outcomeQuestion: TypeSafeChoiceQuestion<SessionStatusJudgmentOutcome> = {
  type: 'choice',
  instructions:
    'Classify the current outcome of the user’s request in this Session. Judge only what the user asked for and what the visible evidence says happened. Do not treat a plan, intent, or an unverified claim as completion.',
  criteria: {
    open: 'The request is still being worked on or has a clear unresolved next step.',
    done: 'The requested answer or work was actually delivered, with no unfinished promise or active child task.',
    blocked:
      'The requested work cannot continue because of a real external dependency or failure that needs follow-up.',
    needs_input:
      'Roomote is waiting for a concrete answer, decision, or action from the user before it can continue.',
    unclear:
      'The visible request and results do not provide enough evidence to choose another outcome confidently.',
  },
};

const confidenceThreshold: Record<SessionStatusJudgmentOutcome, number> = {
  open: 0.7,
  done: 0.9,
  blocked: 0.85,
  needs_input: 0.85,
  unclear: 1,
};

type JudgmentState = {
  objective: string;
  recentMessages: Array<{ role: 'user' | 'assistant'; text: string }>;
  childTasks: Array<{
    title: string;
    state: string;
    request: string | null;
    result: string | null;
  }>;
  goalStatus: string | null;
};

function boundedText(value: unknown, limit: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = redactSecrets(value.trim());
  if (!normalized) return null;
  return normalized.length > limit
    ? `${normalized.slice(0, limit)}…`
    : normalized;
}

function visibleMessageText(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const text = value
    .flatMap((block) => {
      if (!block || typeof block !== 'object') return [];
      const candidate = block as { type?: unknown; text?: unknown };
      return candidate.type === 'text' && typeof candidate.text === 'string'
        ? [candidate.text]
        : [];
    })
    .join('\n');
  return boundedText(text, 2_000);
}

function taskRequest(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  if (record.visibleInTranscript === false) return null;
  for (const key of [
    'description',
    'text',
    'commentBody',
    'issueDescription',
    'issueTitle',
  ]) {
    const value = boundedText(record[key], 1_000);
    if (value) return value;
  }
  return null;
}

function taskResult(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const record = result as Record<string, unknown>;
  return boundedText(record.summary ?? record.message, 500);
}

async function loadJudgmentState(sessionId: string): Promise<{
  state: JudgmentState;
  respondingUntil: Date | null;
  hasActiveTask: boolean;
  pendingUserInput: boolean;
} | null> {
  const [session] = await db
    .select({
      title: sessions.title,
      fastConversationId: sessions.fastConversationId,
      respondingUntil: sessions.respondingUntil,
      goalObjective: sessionGoals.objective,
      goalStatus: sessionGoals.status,
    })
    .from(sessions)
    .leftJoin(sessionGoals, eq(sessionGoals.sessionId, sessions.id))
    .where(eq(sessions.id, sessionId))
    .limit(1);
  if (!session) return null;

  const [messages, taskRows, activeTaskRows] = await Promise.all([
    session.fastConversationId
      ? db
          .select({
            role: fastAgentMessages.role,
            contentBlocks: fastAgentMessages.contentBlocks,
          })
          .from(fastAgentMessages)
          .where(
            and(
              eq(fastAgentMessages.conversationId, session.fastConversationId),
              inArray(fastAgentMessages.role, ['user', 'assistant']),
              sql`case
                when ${fastAgentMessages.metadata} ->> 'visibleInTranscript' is not null
                  then ${fastAgentMessages.metadata} ->> 'visibleInTranscript' = 'true'
                else ${fastAgentMessages.eventType} <> ${ACP_ENVELOPE_EVENT_TYPES.UserPrompt}
              end`,
            ),
          )
          .orderBy(
            desc(fastAgentMessages.ts),
            desc(fastAgentMessages.turnSeq),
            desc(fastAgentMessages.createdAt),
          )
          .limit(MAX_RECENT_MESSAGES)
      : Promise.resolve([]),
    db
      .selectDistinctOn([tasks.id], {
        title: tasks.title,
        state: tasks.state,
        payload: taskRuns.payload,
        result: taskRuns.result,
      })
      .from(sessionTasks)
      .innerJoin(tasks, eq(tasks.id, sessionTasks.taskId))
      .leftJoin(taskRuns, eq(taskRuns.taskId, tasks.id))
      .where(
        and(
          eq(sessionTasks.sessionId, sessionId),
          isNull(tasks.deletedAt),
          eq(tasks.visibility, 'visible'),
        ),
      )
      .orderBy(tasks.id, desc(taskRuns.id))
      .limit(MAX_TASKS),
    db
      .select({ id: tasks.id })
      .from(sessionTasks)
      .innerJoin(tasks, eq(tasks.id, sessionTasks.taskId))
      .where(
        and(
          eq(sessionTasks.sessionId, sessionId),
          isNull(tasks.deletedAt),
          eq(tasks.visibility, 'visible'),
          eq(tasks.state, 'active'),
        ),
      )
      .limit(1),
  ]);

  const recentMessages = messages.reverse().flatMap((message) => {
    const text = visibleMessageText(message.contentBlocks);
    if (!text || (message.role !== 'user' && message.role !== 'assistant')) {
      return [];
    }
    return [{ role: message.role, text }];
  });
  const childTasks = taskRows.map((task) => ({
    title: boundedText(task.title, 300) ?? 'Untitled task',
    state: task.state,
    request: taskRequest(task.payload),
    result: taskResult(task.result),
  }));
  const state: JudgmentState = {
    objective:
      boundedText(session.goalObjective, 1_500) ??
      boundedText(session.title, 500) ??
      'Session request',
    recentMessages,
    childTasks,
    goalStatus: session.goalStatus,
  };

  // Keep the newest evidence; discard oldest message text first if the whole
  // structured state exceeds the fixed request budget.
  while (
    state.recentMessages.length > 0 &&
    JSON.stringify(state).length > MAX_CONTEXT_CHARS
  ) {
    state.recentMessages.shift();
  }
  while (
    state.childTasks.length > 0 &&
    JSON.stringify(state).length > MAX_CONTEXT_CHARS
  ) {
    state.childTasks.pop();
  }

  const pendingUserInput = session.fastConversationId
    ? await hasFastConversationPendingUserInput(db, session.fastConversationId)
    : false;
  return {
    state,
    respondingUntil: session.respondingUntil,
    hasActiveTask: activeTaskRows.length > 0,
    pendingUserInput,
  };
}

export function chooseApplicableSessionStatusJudgment(answer: {
  choice: SessionStatusJudgmentOutcome;
  confidence: number;
  probabilities: Partial<Record<SessionStatusJudgmentOutcome, number>>;
}): {
  outcome: SessionStatusJudgmentOutcome;
  confidence: number;
  probabilities: Partial<Record<SessionStatusJudgmentOutcome, number>>;
} | null {
  if (
    !SESSION_STATUS_JUDGMENT_OUTCOMES.includes(answer.choice) ||
    !Number.isFinite(answer.confidence) ||
    answer.confidence < confidenceThreshold[answer.choice] ||
    !Object.values(answer.probabilities).every(
      (probability) =>
        typeof probability === 'number' &&
        Number.isFinite(probability) &&
        probability >= 0 &&
        probability <= 1,
    )
  ) {
    return null;
  }
  if (answer.choice === 'unclear') return null;
  return {
    outcome: answer.choice,
    confidence: answer.confidence,
    probabilities: answer.probabilities,
  };
}

export async function processSessionStatusJudgmentBatch(
  limit = MAX_JUDGMENTS_PER_TICK,
): Promise<number> {
  if (!(await isDeploymentExperimentEnabled('sessionStatusJudgment'))) {
    await discardPendingSessionStatusJudgments(db);
    return 0;
  }

  const requests = await claimSessionStatusJudgmentRequests(db, limit);
  for (const request of requests) {
    try {
      const snapshot = await loadJudgmentState(request.sessionId);
      if (!snapshot) {
        await completeSessionStatusJudgment(db, {
          id: request.id,
          sessionId: request.sessionId,
          generation: request.generation,
          state: 'ignored',
          errorCode: 'session_missing',
        });
        continue;
      }

      const answers = await evaluateDecisionModel({
        state: snapshot.state,
        questions: { outcome: outcomeQuestion },
        excludeRoomoteModel: true,
      });
      if (!answers) {
        await completeSessionStatusJudgment(db, {
          id: request.id,
          sessionId: request.sessionId,
          generation: request.generation,
          state: 'ignored',
          errorCode: 'judgment_unconfigured',
        });
        continue;
      }

      const decision = chooseApplicableSessionStatusJudgment(answers.outcome);
      if (!decision) {
        await completeSessionStatusJudgment(db, {
          id: request.id,
          sessionId: request.sessionId,
          generation: request.generation,
          state: 'ignored',
          outcome: answers.outcome.choice,
          confidence: answers.outcome.confidence,
          probabilities: answers.outcome.probabilities,
          errorCode: 'low_confidence',
        });
        continue;
      }

      const liveTurn =
        snapshot.respondingUntil !== null &&
        snapshot.respondingUntil.getTime() > Date.now();
      const goalStillActive = snapshot.state.goalStatus === 'active';
      if (
        decision.outcome === 'done' &&
        (liveTurn ||
          snapshot.hasActiveTask ||
          snapshot.pendingUserInput ||
          goalStillActive)
      ) {
        await completeSessionStatusJudgment(db, {
          id: request.id,
          sessionId: request.sessionId,
          generation: request.generation,
          state: 'ignored',
          outcome: decision.outcome,
          confidence: decision.confidence,
          probabilities: decision.probabilities,
          errorCode: 'live_work',
        });
        continue;
      }

      await completeSessionStatusJudgment(db, {
        id: request.id,
        sessionId: request.sessionId,
        generation: request.generation,
        state: 'applied',
        outcome: decision.outcome,
        confidence: decision.confidence,
        probabilities: decision.probabilities,
      });
    } catch (error) {
      await retryOrFailSessionStatusJudgment(db, {
        id: request.id,
        attempts: request.attempts,
        errorCode:
          error instanceof Error && error.name === 'AbortError'
            ? 'timeout'
            : 'provider_error',
      });
      console.warn('[sessions] Session status judgment failed.');
    }
  }
  return requests.length;
}
