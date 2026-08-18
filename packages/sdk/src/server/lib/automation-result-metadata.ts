import {
  and,
  db,
  deploymentSettings,
  eq,
  llmUsageEvents,
  sql,
  taskRuns,
  tasks,
} from '@roomote/db/server';
import { formatAutomationResultSubtitle } from '@roomote/slack';
import {
  DEFAULT_MODEL_ROLE_REASONING_EFFORTS,
  getReasoningEffortLabel,
  getTaskModelDisplayName,
  getTaskModelOptionById,
  isReasoningEffort,
  normalizeDeploymentModelConfig,
} from '@roomote/types';

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function formatAutomationTriggerLabel(
  trigger: string,
  scheduleMode?: string | null,
): string {
  if (trigger !== 'schedule') return capitalize(trigger);

  switch (scheduleMode) {
    case 'every_hour':
      return 'Hourly';
    case 'every_6_hours':
      return 'Every 6 hours';
    case 'daily':
      return 'Daily';
    case 'weekly':
      return 'Weekly';
    default:
      return 'Scheduled';
  }
}

function getPayloadReasoningEffort(payload: unknown) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }

  const reasoningEffort = (payload as { reasoningEffort?: unknown })
    .reasoningEffort;
  return isReasoningEffort(reasoningEffort) ? reasoningEffort : null;
}

export async function resolveAutomationResultSubtitle(params: {
  taskId: string;
  runId: number;
  scheduleMode?: string | null;
}): Promise<{ type: 'plain_text'; text: string } | undefined> {
  const [task, run, deployment, [usage]] = await Promise.all([
    db.query.tasks.findFirst({
      columns: { trigger: true, model: true },
      where: eq(tasks.id, params.taskId),
    }),
    db.query.taskRuns.findFirst({
      columns: {
        payload: true,
        createdAt: true,
        startedAt: true,
        completedAt: true,
      },
      where: eq(taskRuns.id, params.runId),
    }),
    db.query.deploymentSettings.findFirst({
      columns: { runtimeModelConfig: true, taskModelSettings: true },
      where: eq(deploymentSettings.id, 'default'),
    }),
    db
      .select({
        costMicroUsd: sql<number>`coalesce(sum(${llmUsageEvents.costMicroUsd}), 0)::bigint`,
      })
      .from(llmUsageEvents)
      .where(
        and(
          eq(llmUsageEvents.runId, params.runId),
          eq(llmUsageEvents.usageType, 'inference'),
        ),
      ),
  ]);

  if (!task || !run) return undefined;

  const modelOption = getTaskModelOptionById(
    task.model,
    deployment?.taskModelSettings,
  );
  const supportsReasoning = modelOption?.metadata?.supportsReasoning !== false;
  const runtimeModelConfig = normalizeDeploymentModelConfig(
    deployment?.runtimeModelConfig,
  );
  const envReasoningEffort = process.env.R_MODEL_REASONING_EFFORT?.trim();
  const reasoningEffort = supportsReasoning
    ? (getPayloadReasoningEffort(run.payload) ??
      (isReasoningEffort(envReasoningEffort) ? envReasoningEffort : null) ??
      runtimeModelConfig.roomoteModelReasoningEffort ??
      DEFAULT_MODEL_ROLE_REASONING_EFFORTS.coding)
    : null;
  const model = [
    getTaskModelDisplayName(task.model, deployment?.taskModelSettings),
    reasoningEffort ? getReasoningEffortLabel(reasoningEffort) : null,
  ]
    .filter(Boolean)
    .join(' ');
  const startedAt = run.startedAt ?? run.createdAt;
  const completedAt = run.completedAt ?? new Date();

  return {
    type: 'plain_text',
    text: formatAutomationResultSubtitle({
      trigger: formatAutomationTriggerLabel(task.trigger, params.scheduleMode),
      model,
      costMicroUsd: Number(usage?.costMicroUsd ?? 0),
      durationMs: completedAt.getTime() - startedAt.getTime(),
    }),
  };
}
