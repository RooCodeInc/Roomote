import { asc, desc, eq } from 'drizzle-orm';

import type {
  CloudJobEventDetails,
  CloudJobEventSource,
  CloudJobEventType,
  ComputeProviderMutationEvent,
  ComputeProviderMutationObserver,
} from '@roomote/types';

import type { DatabaseOrTransaction } from '../db';
import { taskRunEvents, taskRuns } from '../schema';

interface RecordCloudJobEventInput {
  runId: number;
  taskId?: string;
  source: CloudJobEventSource;
  eventType: CloudJobEventType;
  message?: string;
  details?: CloudJobEventDetails;
  createdAt?: Date;
}

interface ListCloudJobEventsOptions {
  runId: number;
  limit?: number;
  order?: 'asc' | 'desc';
}

interface RecordComputeProviderMutationEventInput extends ComputeProviderMutationEvent {
  runId: number;
  taskId?: string;
  details?: CloudJobEventDetails;
  createdAt?: Date;
}

async function resolveRunContext(
  database: DatabaseOrTransaction,
  runId: number,
): Promise<{ taskId: string }> {
  const [run] = await database
    .select({ taskId: taskRuns.taskId })
    .from(taskRuns)
    .where(eq(taskRuns.id, runId))
    .limit(1);

  if (!run) {
    throw new Error(`Cannot record event for missing run #${runId}`);
  }

  return run;
}

export async function recordCloudJobEvent(
  database: DatabaseOrTransaction,
  input: RecordCloudJobEventInput,
) {
  const context = input.taskId
    ? { taskId: input.taskId }
    : await resolveRunContext(database, input.runId);

  const [event] = await database
    .insert(taskRunEvents)
    .values({
      runId: input.runId,
      taskId: context.taskId,
      source: input.source,
      eventType: input.eventType,
      message: input.message,
      details: input.details ?? {},
      createdAt: input.createdAt ?? new Date(),
    })
    .returning();

  return event;
}

export async function recordSnapshotResumeEvent(
  database: DatabaseOrTransaction,
  input: {
    runId: number;
    taskId?: string;
    eventType: CloudJobEventType;
    message: string;
    details?: CloudJobEventDetails;
  },
) {
  return recordCloudJobEvent(database, {
    runId: input.runId,
    taskId: input.taskId,
    source: 'snapshot_resume',
    eventType: input.eventType,
    message: input.message,
    details: input.details,
  });
}

export async function recordJobLifecycleEvent(
  database: DatabaseOrTransaction,
  input: {
    runId: number;
    taskId?: string;
    eventType: CloudJobEventType;
    message: string;
    details?: CloudJobEventDetails;
    createdAt?: Date;
  },
) {
  return recordCloudJobEvent(database, {
    runId: input.runId,
    taskId: input.taskId,
    source: 'job_lifecycle',
    eventType: input.eventType,
    message: input.message,
    details: input.details,
    createdAt: input.createdAt,
  });
}

export async function recordComputeProviderMutationEvent(
  database: DatabaseOrTransaction,
  input: RecordComputeProviderMutationEventInput,
) {
  return recordCloudJobEvent(database, {
    runId: input.runId,
    taskId: input.taskId,
    source: 'compute_provider',
    eventType: input.eventType,
    message: input.message,
    details: {
      ...(input.details ?? {}),
      provider: input.provider,
      operation: input.operation,
      instanceId: input.instanceId ?? null,
    },
    createdAt: input.createdAt,
  });
}

export async function recordComputeProviderMutationEventSafe(
  database: DatabaseOrTransaction,
  input: RecordComputeProviderMutationEventInput,
  options?: { logPrefix?: string; logger?: Pick<Console, 'warn'> },
) {
  try {
    await recordComputeProviderMutationEvent(database, input);
  } catch (error) {
    const logger = options?.logger ?? console;
    const prefix = options?.logPrefix ?? 'recordComputeProviderMutationEvent';
    logger.warn(
      `[${prefix}] Failed to persist compute-provider event for cloud job #${
        input.runId
      }: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function createComputeProviderMutationEventRecorder(
  database: DatabaseOrTransaction,
  context: {
    runId: number;
    taskId?: string;
  },
  options?: { logPrefix?: string; logger?: Pick<Console, 'warn'> },
): ComputeProviderMutationObserver {
  return async (event) => {
    await recordComputeProviderMutationEventSafe(
      database,
      {
        ...context,
        ...event,
      },
      options,
    );
  };
}

export async function listCloudJobEvents(
  database: DatabaseOrTransaction,
  options: ListCloudJobEventsOptions,
) {
  const orderBy =
    options.order === 'asc'
      ? asc(taskRunEvents.createdAt)
      : desc(taskRunEvents.createdAt);

  return database
    .select()
    .from(taskRunEvents)
    .where(eq(taskRunEvents.runId, options.runId))
    .orderBy(orderBy)
    .limit(options.limit ?? 100);
}
