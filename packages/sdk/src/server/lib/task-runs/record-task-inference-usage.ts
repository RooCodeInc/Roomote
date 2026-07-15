import { db, eq, llmUsageEvents, taskRuns } from '@roomote/db/server';

type TaskInferenceUsageCostSource = 'opencode_message' | 'missing';

interface RecordTaskInferenceUsageInput {
  runId: number;
  harnessSessionId: string;
  messageId: string;
  providerId?: string | null;
  modelId?: string | null;
  agent?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  reasoningTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  totalTokens?: number | null;
  contextTokens?: number | null;
  costMicroUsd?: number | null;
  costSource?: TaskInferenceUsageCostSource | null;
  messageCreatedAt?: Date | null;
  messageCompletedAt?: Date | null;
  details?: Record<string, unknown> | null;
}

export interface RecordLlmUsageInput {
  source?: string;
  usageType?: 'inference' | 'embedding' | 'rerank' | 'other';
  eventKey?: string | null;
  taskId?: string | null;
  runId?: number | null;
  userId?: string | null;
  environmentId?: string | null;
  harnessSessionId?: string | null;
  messageId?: string | null;
  providerId?: string | null;
  modelId?: string | null;
  agent?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  reasoningTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  totalTokens?: number | null;
  contextTokens?: number | null;
  costMicroUsd?: number | null;
  costSource?: TaskInferenceUsageCostSource | null;
  messageCreatedAt?: Date | null;
  messageCompletedAt?: Date | null;
  pricingMetadata?: Record<string, unknown> | null;
  details?: Record<string, unknown> | null;
}

interface TaskInferenceUsageTaskRun {
  id: number;
  taskId: string | null;
}

function clampOptionalInteger(value: number | null | undefined): number {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue)) {
    return 0;
  }

  return Math.max(0, Math.trunc(numericValue));
}

function clampOptionalCostMicroUsd(value: number | null | undefined): number {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue)) {
    return 0;
  }

  return Math.max(0, Math.round(numericValue));
}

function normalizeDetails(
  input: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  return input ? { ...input } : {};
}

function normalizeAgent(value: string | null | undefined): string | null {
  const trimmed = value?.trim();

  return trimmed && trimmed.length > 0 ? trimmed : null;
}

async function loadTaskInferenceUsageTaskRun(
  runId: number,
): Promise<TaskInferenceUsageTaskRun | null> {
  return (
    (await db.query.taskRuns.findFirst({
      where: eq(taskRuns.id, runId),
      columns: {
        id: true,
        taskId: true,
      },
    })) ?? null
  );
}

export async function recordTaskInferenceUsage(
  input: RecordTaskInferenceUsageInput,
): Promise<{ recorded: boolean; taskId?: string }> {
  const taskRun = await loadTaskInferenceUsageTaskRun(input.runId);

  if (!taskRun) {
    throw new Error(`Task run ${input.runId} not found`);
  }

  if (!taskRun.taskId) {
    return { recorded: false };
  }

  return recordLlmUsage({
    ...input,
    source: 'opencode',
    usageType: 'inference',
    taskId: taskRun.taskId,
    runId: taskRun.id,
  }).then(() => ({ recorded: true, taskId: taskRun.taskId! }));
}

export async function recordLlmUsage(
  input: RecordLlmUsageInput,
): Promise<{ recorded: boolean; id?: string }> {
  if (!input.taskId && !input.eventKey) {
    throw new Error('Non-task LLM usage requires an eventKey');
  }

  if (
    input.taskId &&
    !input.eventKey &&
    !(input.harnessSessionId?.trim() && input.messageId?.trim())
  ) {
    throw new Error(
      'Task LLM usage requires an eventKey or non-empty harness session and message IDs',
    );
  }

  const now = new Date();
  const inputTokens = clampOptionalInteger(input.inputTokens);
  const outputTokens = clampOptionalInteger(input.outputTokens);
  const reasoningTokens = clampOptionalInteger(input.reasoningTokens);
  const cacheReadTokens = clampOptionalInteger(input.cacheReadTokens);
  const cacheWriteTokens = clampOptionalInteger(input.cacheWriteTokens);
  const totalTokens =
    input.totalTokens === undefined || input.totalTokens === null
      ? inputTokens +
        outputTokens +
        reasoningTokens +
        cacheReadTokens +
        cacheWriteTokens
      : clampOptionalInteger(input.totalTokens);
  const contextTokens =
    input.contextTokens === undefined || input.contextTokens === null
      ? inputTokens + cacheReadTokens
      : clampOptionalInteger(input.contextTokens);
  const costSource = input.costSource ?? 'missing';
  const agent = normalizeAgent(input.agent);

  const values = {
    source: input.source ?? 'roomote',
    usageType: input.usageType ?? 'inference',
    taskId: input.taskId ?? null,
    runId: input.runId ?? null,
    userId: input.userId ?? null,
    environmentId: input.environmentId ?? null,
    eventKey: input.eventKey ?? null,
    harnessSessionId: input.harnessSessionId ?? null,
    messageId: input.messageId ?? null,
    providerId: input.providerId ?? null,
    modelId: input.modelId ?? null,
    agent,
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
    contextTokens,
    costMicroUsd: clampOptionalCostMicroUsd(input.costMicroUsd),
    costSource,
    messageCreatedAt: input.messageCreatedAt ?? null,
    messageCompletedAt: input.messageCompletedAt ?? null,
    pricingMetadata: input.pricingMetadata ? { ...input.pricingMetadata } : {},
    details: normalizeDetails(input.details),
    updatedAt: now,
  };

  const query = db.insert(llmUsageEvents).values(values);

  if (input.eventKey) {
    await query.onConflictDoUpdate({
      target: llmUsageEvents.eventKey,
      set: { ...values },
    });
  } else if (input.harnessSessionId && input.messageId) {
    await query.onConflictDoUpdate({
      target: [llmUsageEvents.harnessSessionId, llmUsageEvents.messageId],
      set: { ...values },
    });
  } else {
    await query;
  }

  return { recorded: true };
}
