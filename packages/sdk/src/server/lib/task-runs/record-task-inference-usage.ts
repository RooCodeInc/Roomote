import { db, eq, recordLlmUsage, taskRuns } from '@roomote/db/server';
import type { LlmUsageCostSource } from '@roomote/types';

export { recordLlmUsage, type RecordLlmUsageInput } from '@roomote/db/server';

type TaskInferenceUsageCostSource = LlmUsageCostSource;

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

interface TaskInferenceUsageTaskRun {
  id: number;
  taskId: string | null;
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
