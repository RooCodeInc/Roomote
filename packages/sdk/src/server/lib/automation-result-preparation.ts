import { Queue } from 'bullmq';
import { z } from 'zod';

import {
  and,
  automationResults,
  customAutomations,
  db,
  eq,
  isNull,
  sessions,
  taskArtifacts,
  taskPullRequests,
  taskRuns,
  tasks,
} from '@roomote/db/server';
import {
  generateTrackedNonTaskObject,
  NON_TASK_INFERENCE_SURFACES,
} from '@roomote/cloud-agents/server';
import { getRedis } from '@roomote/redis';

export const AUTOMATION_RESULT_PREPARATION_QUEUE_NAME =
  'automation-result-preparation';
export const AUTOMATION_RESULT_PREPARATION_ATTEMPTS = 3;

const preparedResultSchema = z
  .object({
    headline: z.string().trim().min(1).max(100),
    decisionContext: z.string().trim().min(1).max(280),
    referenceKeys: z.array(z.string()).max(5),
  })
  .strict();

let queue: Queue<{ resultId: string }> | null = null;

function getQueue() {
  queue ??= new Queue(AUTOMATION_RESULT_PREPARATION_QUEUE_NAME, {
    connection: getRedis(),
  });
  return queue;
}

export async function enqueueAutomationResultPreparation(resultId: string) {
  try {
    await getQueue().add(
      'prepare',
      { resultId },
      {
        jobId: `automation-result-${resultId}-v1`,
        attempts: AUTOMATION_RESULT_PREPARATION_ATTEMPTS,
        backoff: { type: 'exponential', delay: 2_000 },
        removeOnComplete: { age: 3_600, count: 1_000 },
        removeOnFail: { age: 24 * 3_600 },
      },
    );
    return true;
  } catch (error) {
    console.error(
      `[AutomationResultPreparation] Failed to enqueue ${resultId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

export async function recoverPendingAutomationResultPreparations(limit = 100) {
  const rows = await db.query.automationResults.findMany({
    where: and(
      eq(automationResults.preparationStatus, 'pending'),
      isNull(automationResults.acceptedAt),
      isNull(automationResults.ignoredAt),
      isNull(automationResults.supersededAt),
    ),
    columns: { id: true },
    limit,
  });
  await Promise.all(
    rows.map((row) => enqueueAutomationResultPreparation(row.id)),
  );
  return rows.length;
}

async function collectPreparationContext(resultId: string) {
  const result = await db.query.automationResults.findFirst({
    where: eq(automationResults.id, resultId),
  });
  if (!result || result.preparationStatus !== 'pending') return null;

  const [task, run, sourceSession, customAutomation, pullRequests, artifacts] =
    await Promise.all([
      result.sourceTaskId
        ? db.query.tasks.findFirst({
            where: eq(tasks.id, result.sourceTaskId),
            columns: { id: true, title: true, prompt: true, state: true },
          })
        : null,
      result.sourceRunId
        ? db.query.taskRuns.findFirst({
            where: eq(taskRuns.id, result.sourceRunId),
            columns: { status: true, errorCode: true, error: true },
          })
        : null,
      result.sourceSessionId
        ? db.query.sessions.findFirst({
            where: eq(sessions.id, result.sourceSessionId),
            columns: { fastConversationId: true },
          })
        : null,
      result.customAutomationId
        ? db.query.customAutomations.findFirst({
            where: eq(customAutomations.id, result.customAutomationId),
            columns: { prompt: true },
          })
        : null,
      result.sourceTaskId
        ? db.query.taskPullRequests.findMany({
            where: eq(taskPullRequests.taskId, result.sourceTaskId),
            columns: { id: true, prTitle: true, status: true },
            limit: 10,
          })
        : [],
      result.sourceTaskId || result.sourceSessionId
        ? db.query.taskArtifacts.findMany({
            where: result.sourceTaskId
              ? eq(taskArtifacts.taskId, result.sourceTaskId)
              : eq(taskArtifacts.sessionId, result.sourceSessionId!),
            columns: { id: true, path: true, artifactType: true },
            limit: 10,
          })
        : [],
    ]);

  const references = [
    ...(task
      ? [{ key: `task:${task.id}`, type: 'task', label: task.title }]
      : []),
    ...(result.sourceSessionId
      ? [
          {
            key: `session:${result.sourceSessionId}`,
            type: 'session',
            label: 'Source session',
          },
        ]
      : []),
    ...pullRequests.map((pullRequest) => ({
      key: `pr:${pullRequest.id}`,
      type: 'pull_request',
      label: pullRequest.prTitle ?? 'Pull request',
      status: pullRequest.status,
    })),
    ...artifacts.map((artifact) => ({
      key: `artifact:${artifact.id}`,
      type: 'artifact',
      label: artifact.path,
      artifactType: artifact.artifactType,
    })),
  ];

  return { result, task, run, sourceSession, customAutomation, references };
}

export async function processAutomationResultPreparation(params: {
  resultId: string;
  finalAttempt: boolean;
}) {
  const context = await collectPreparationContext(params.resultId);
  if (!context) return;

  try {
    const instructions =
      context.customAutomation?.prompt ?? context.task?.prompt ?? '';
    const { object } = await generateTrackedNonTaskObject({
      surface: NON_TASK_INFERENCE_SURFACES.automationResultPreparation,
      userId: context.result.userId,
      taskId: context.result.sourceTaskId,
      fastConversationId: context.sourceSession?.fastConversationId,
      modelRole: 'small',
      maxOutputTokens: 350,
      structuredOutputRetryCount: 1,
      schema: preparedResultSchema,
      system:
        'Prepare an automation inbox item from the supplied bounded facts. Write a factual outcome headline and exactly one concise decision-context sentence. State only concrete outcomes, material changes, scope, blockers, limitations, or decisions present in the input. Do not invent urgency, priority, ownership, deadlines, actions, or completion. Do not describe the process of checking or investigating. Select only exact reference keys supplied in candidates; never output URLs or executable instructions.',
      prompt: JSON.stringify({
        automation: context.result.automationName,
        instructions: instructions.slice(0, 4_000),
        outcome: context.result.content.slice(0, 12_000),
        state: {
          task: context.task?.state ?? null,
          run: context.run?.status ?? null,
          errorCode: context.run?.errorCode ?? null,
          blocker: context.run?.error?.slice(0, 1_000) ?? null,
        },
        candidates: context.references,
      }),
    });
    const validReferenceKeys = new Set(
      context.references.map((reference) => reference.key),
    );
    const selectedReferenceKeys = [
      ...new Set(
        object.referenceKeys.filter((key) => validReferenceKeys.has(key)),
      ),
    ];
    await db
      .update(automationResults)
      .set({
        headline: object.headline,
        decisionContext: object.decisionContext,
        selectedReferenceKeys,
        preparationStatus: 'ready',
        preparationAttempts: context.result.preparationAttempts + 1,
        preparedAt: new Date(),
        preparationErrorCode: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(automationResults.id, params.resultId),
          eq(automationResults.preparationStatus, 'pending'),
        ),
      );
  } catch (error) {
    await db
      .update(automationResults)
      .set({
        preparationAttempts: context.result.preparationAttempts + 1,
        ...(params.finalAttempt
          ? {
              preparationStatus: 'failed' as const,
              preparedAt: new Date(),
              preparationErrorCode: 'generation_failed',
            }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(automationResults.id, params.resultId));
    if (!params.finalAttempt) throw error;
    console.error(
      `[AutomationResultPreparation] Falling back for ${params.resultId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
