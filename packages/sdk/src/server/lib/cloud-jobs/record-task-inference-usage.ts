import { db, eq, taskInferenceUsageEvents, taskRuns } from '@roomote/db/server';

type TaskInferenceUsageCostSource = 'opencode_message' | 'missing';

interface RecordTaskInferenceUsageInput {
  cloudJobId: number;
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

interface TaskInferenceUsageCloudJob {
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

async function loadTaskInferenceUsageCloudJob(
  cloudJobId: number,
): Promise<TaskInferenceUsageCloudJob | null> {
  return (
    (await db.query.taskRuns.findFirst({
      where: eq(taskRuns.id, cloudJobId),
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
  const cloudJob = await loadTaskInferenceUsageCloudJob(input.cloudJobId);

  if (!cloudJob) {
    throw new Error(`Cloud job ${input.cloudJobId} not found`);
  }

  if (!cloudJob.taskId) {
    return { recorded: false };
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

  await db
    .insert(taskInferenceUsageEvents)
    .values({
      source: 'opencode',
      taskId: cloudJob.taskId,
      runId: cloudJob.id,
      harnessSessionId: input.harnessSessionId,
      messageId: input.messageId,
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
      details: normalizeDetails(input.details),
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        taskInferenceUsageEvents.harnessSessionId,
        taskInferenceUsageEvents.messageId,
      ],
      set: {
        runId: cloudJob.id,
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
        details: normalizeDetails(input.details),
        updatedAt: now,
      },
    });

  return { recorded: true, taskId: cloudJob.taskId };
}
