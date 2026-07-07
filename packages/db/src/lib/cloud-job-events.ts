import { asc, desc, eq } from 'drizzle-orm';

import type {
  CloudJobEventDetails,
  CloudJobEventSource,
  CloudJobEventType,
  ComputeProviderMutationEvent,
  ComputeProviderMutationObserver,
} from '@roomote/types';

import type { DatabaseOrTransaction } from '../db';
import { cloudJobEvents, cloudJobs } from '../schema';

interface RecordCloudJobEventInput {
  cloudJobId: number;
  taskId?: string;
  source: CloudJobEventSource;
  eventType: CloudJobEventType;
  message?: string;
  details?: CloudJobEventDetails;
  createdAt?: Date;
}

interface ListCloudJobEventsOptions {
  cloudJobId: number;
  limit?: number;
  order?: 'asc' | 'desc';
}

interface RecordComputeProviderMutationEventInput extends ComputeProviderMutationEvent {
  cloudJobId: number;
  taskId?: string;
  details?: CloudJobEventDetails;
  createdAt?: Date;
}

async function resolveCloudJobContext(
  database: DatabaseOrTransaction,
  cloudJobId: number,
): Promise<{ taskId: string }> {
  const [cloudJob] = await database
    .select({ taskId: cloudJobs.taskId })
    .from(cloudJobs)
    .where(eq(cloudJobs.id, cloudJobId))
    .limit(1);

  if (!cloudJob) {
    throw new Error(`Cannot record event for missing cloud job #${cloudJobId}`);
  }

  return cloudJob;
}

export async function recordCloudJobEvent(
  database: DatabaseOrTransaction,
  input: RecordCloudJobEventInput,
) {
  const context = input.taskId
    ? { taskId: input.taskId }
    : await resolveCloudJobContext(database, input.cloudJobId);

  const [event] = await database
    .insert(cloudJobEvents)
    .values({
      cloudJobId: input.cloudJobId,
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
    cloudJobId: number;
    taskId?: string;
    eventType: CloudJobEventType;
    message: string;
    details?: CloudJobEventDetails;
  },
) {
  return recordCloudJobEvent(database, {
    cloudJobId: input.cloudJobId,
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
    cloudJobId: number;
    taskId?: string;
    eventType: CloudJobEventType;
    message: string;
    details?: CloudJobEventDetails;
    createdAt?: Date;
  },
) {
  return recordCloudJobEvent(database, {
    cloudJobId: input.cloudJobId,
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
    cloudJobId: input.cloudJobId,
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
        input.cloudJobId
      }: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function createComputeProviderMutationEventRecorder(
  database: DatabaseOrTransaction,
  context: {
    cloudJobId: number;
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
      ? asc(cloudJobEvents.createdAt)
      : desc(cloudJobEvents.createdAt);

  return database
    .select()
    .from(cloudJobEvents)
    .where(eq(cloudJobEvents.cloudJobId, options.cloudJobId))
    .orderBy(orderBy)
    .limit(options.limit ?? 100);
}
