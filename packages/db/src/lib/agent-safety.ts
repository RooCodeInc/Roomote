import { and, desc, eq } from 'drizzle-orm';
import {
  AGENT_SAFETY_STOP_TEXT,
  ACP_ENVELOPE_EVENT_TYPES,
  getFastAgentParentFromPayload,
  ROOMOTE_RUNTIME_TASK_MESSAGE_PROTOCOL,
  type AgentSafetyReason,
  type AgentSafetyStopDetails,
} from '@roomote/types';
import { db } from '../db';
import {
  tasks,
  taskRuns,
  taskMessages,
  fastAgentMessages,
  fastAgentConversations,
} from '../schema';

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function stopInTransaction(
  tx: Transaction,
  taskId: string,
  reason: AgentSafetyReason,
  runId?: number,
  details?: AgentSafetyStopDetails,
) {
  const [task] = await tx
    .select()
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .for('update');
  if (!task) throw new Error('Task not found for inference admission');
  if (task.safetyStoppedAt) return;
  const stoppedAt = new Date();
  await tx
    .update(tasks)
    .set({ safetyStoppedAt: stoppedAt, safetyStopReason: reason })
    .where(eq(tasks.id, taskId));
  const [run] = await tx
    .select()
    .from(taskRuns)
    .where(
      and(
        eq(taskRuns.taskId, taskId),
        ...(runId === undefined ? [] : [eq(taskRuns.id, runId)]),
      ),
    )
    .orderBy(desc(taskRuns.id))
    .limit(1);
  if (!run) throw new Error('Safety stop requires a persisted task run');
  const passText = details
    ? ` Pass: ${details.sessionId ?? 'helper'}; steps: ${details.steps ?? 0}; completed tools: ${details.completedTools ?? 0}; identical completions: ${details.identicalCompletions ?? 0}; elapsed: ${Math.round((details.elapsedMs ?? 0) / 1000)}s.`
    : '';
  const text = `${AGENT_SAFETY_STOP_TEXT}\n\nReason: ${reason}.${passText} Provider requests admitted: ${task.inferenceRequests}/${task.inferenceRequestLimit}. Partial results are retained; an interrupted review is not a clean review.`;
  const ts = stoppedAt.getTime();
  const contentBlocks = [{ type: 'text' as const, text }];
  const metadata = { source: 'agent_safety_stop', visibleInTranscript: true };
  await tx.insert(taskMessages).values({
    taskId,
    runId: run.id,
    ts,
    protocol: ROOMOTE_RUNTIME_TASK_MESSAGE_PROTOCOL,
    eventType: ACP_ENVELOPE_EVENT_TYPES.AgentSafetyStop,
    role: 'assistant',
    contentBlocks,
    metadata,
    payload: { text, safetyStop: { reason } },
  });
  const parent = getFastAgentParentFromPayload(run.payload);
  // A deleted parent must not prevent the task latch/notice from committing.
  const [parentConversation] = parent
    ? await tx
        .select({ id: fastAgentConversations.id })
        .from(fastAgentConversations)
        .where(eq(fastAgentConversations.id, parent.sessionId))
        .for('key share')
    : [];
  if (parentConversation) {
    await tx
      .insert(fastAgentMessages)
      .values({
        conversationId: parentConversation.id,
        eventId: `agent-safety:${taskId}`,
        turnId: `agent-safety:${taskId}`,
        turnSeq: 0,
        ts,
        eventType: ACP_ENVELOPE_EVENT_TYPES.AgentSafetyStop,
        role: 'assistant',
        contentBlocks: [{ type: 'text', text: `Task ${taskId}: ${text}` }],
        metadata,
        payload: { text, taskId, safetyStop: { reason } },
        source: 'agent_safety_stop',
      })
      .onConflictDoNothing();
  }
}

/** Latch and notices commit together, without a model call or volatile queue. */
export async function stopTaskForAgentSafety(input: {
  taskId: string;
  reason: AgentSafetyReason;
  runId?: number;
  details?: AgentSafetyStopDetails;
}): Promise<void> {
  await db.transaction((tx) =>
    stopInTransaction(
      tx,
      input.taskId,
      input.reason,
      input.runId,
      input.details,
    ),
  );
}

/** Serialize all providers/children/runs on the same task row. Never refund. */
export async function admitTaskInferenceRequest(
  taskId: string,
  runId?: number,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [task] = await tx
      .select({
        requests: tasks.inferenceRequests,
        limit: tasks.inferenceRequestLimit,
        stopped: tasks.safetyStoppedAt,
      })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .for('update');
    if (!task) throw new Error('Task not found for inference admission');
    if (task.stopped) return false;
    if (task.requests >= task.limit) {
      await stopInTransaction(tx, taskId, 'task_request_limit', runId);
      return false;
    }
    await tx
      .update(tasks)
      .set({ inferenceRequests: task.requests + 1 })
      .where(eq(tasks.id, taskId));
    return true;
  });
}
