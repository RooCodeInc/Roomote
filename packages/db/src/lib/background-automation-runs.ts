import { and, desc, eq, inArray } from 'drizzle-orm';

import type {
  BackgroundAutomationKey,
  BackgroundAutomationRunStatus,
  BackgroundAutomationRunTriggerKind,
} from '@roomote/types';

import { type DatabaseOrTransaction, db } from '../db';
import { backgroundAutomationRuns, backgroundAutomations } from '../schema';

type RunArtifactPatch = {
  taskId?: string | null;
  slackChannelId?: string | null;
  threadTs?: string | null;
  metadata?: Record<string, unknown>;
};

type TerminalRunStatus = Exclude<
  BackgroundAutomationRunStatus,
  'queued' | 'running'
>;

function mergeMetadata(
  current: Record<string, unknown>,
  patch: Record<string, unknown> | undefined,
) {
  return patch ? { ...current, ...patch } : current;
}

function buildBackgroundAutomationCompletionUpdate(params: {
  status: TerminalRunStatus;
  finishedAt: Date;
  error?: string | null;
  lastRunAt?: Date | 'skip';
}) {
  const base: Partial<typeof backgroundAutomations.$inferInsert> = {
    updatedAt: params.finishedAt,
  };

  if (params.lastRunAt !== 'skip') {
    base.lastRunAt = params.lastRunAt ?? params.finishedAt;
  }

  if (params.status === 'failed') {
    return {
      ...base,
      lastFailedAt: params.finishedAt,
      lastError: params.error?.trim() || 'Automation run failed.',
    };
  }

  if (params.status === 'succeeded') {
    return {
      ...base,
      lastSucceededAt: params.finishedAt,
      lastError: null,
    };
  }

  return {
    ...base,
    lastError: null,
  };
}

export async function createQueuedBackgroundAutomationRun(
  tx: DatabaseOrTransaction,
  params: {
    automationKey: BackgroundAutomationKey;
    bullmqJobId: string;
    triggerKind: BackgroundAutomationRunTriggerKind;
    queuedAt: Date;
    metadata?: Record<string, unknown>;
  },
) {
  const [run] = await tx
    .insert(backgroundAutomationRuns)
    .values({
      automationKey: params.automationKey,
      bullmqJobId: params.bullmqJobId,
      triggerKind: params.triggerKind,
      status: 'queued',
      metadata: params.metadata ?? {},
      createdAt: params.queuedAt,
      updatedAt: params.queuedAt,
    })
    .onConflictDoNothing({
      target: [
        backgroundAutomationRuns.automationKey,
        backgroundAutomationRuns.bullmqJobId,
      ],
    })
    .returning({
      id: backgroundAutomationRuns.id,
    });

  return run ?? null;
}

export async function startBackgroundAutomationRun(
  tx: DatabaseOrTransaction,
  params: {
    automationKey: BackgroundAutomationKey;
    bullmqJobId: string;
    triggerKind: BackgroundAutomationRunTriggerKind;
    startedAt: Date;
    metadata?: Record<string, unknown>;
  },
) {
  const [existing] = await tx
    .select({
      id: backgroundAutomationRuns.id,
      metadata: backgroundAutomationRuns.metadata,
    })
    .from(backgroundAutomationRuns)
    .where(
      and(
        eq(backgroundAutomationRuns.automationKey, params.automationKey),
        eq(backgroundAutomationRuns.bullmqJobId, params.bullmqJobId),
      ),
    )
    .limit(1);

  const mergedMetadata = mergeMetadata(
    existing?.metadata ?? {},
    params.metadata,
  );

  const [run] = await tx
    .insert(backgroundAutomationRuns)
    .values({
      automationKey: params.automationKey,
      bullmqJobId: params.bullmqJobId,
      triggerKind: params.triggerKind,
      status: 'running',
      startedAt: params.startedAt,
      metadata: mergedMetadata,
      createdAt: params.startedAt,
      updatedAt: params.startedAt,
    })
    .onConflictDoUpdate({
      target: [
        backgroundAutomationRuns.automationKey,
        backgroundAutomationRuns.bullmqJobId,
      ],
      set: {
        triggerKind: params.triggerKind,
        status: 'running',
        startedAt: params.startedAt,
        error: null,
        metadata: mergedMetadata,
        updatedAt: params.startedAt,
      },
    })
    .returning({
      id: backgroundAutomationRuns.id,
    });

  if (!run) {
    throw new Error('Failed to start background automation run.');
  }

  return run;
}

export async function updateBackgroundAutomationRunArtifactsById(
  tx: DatabaseOrTransaction,
  params: {
    runId: string;
  } & RunArtifactPatch,
) {
  const [existing] = await tx
    .select({
      metadata: backgroundAutomationRuns.metadata,
    })
    .from(backgroundAutomationRuns)
    .where(eq(backgroundAutomationRuns.id, params.runId))
    .limit(1);

  if (!existing) {
    return null;
  }

  const update: Partial<typeof backgroundAutomationRuns.$inferInsert> = {
    updatedAt: new Date(),
    metadata: mergeMetadata(existing.metadata ?? {}, params.metadata),
  };

  if (params.taskId !== undefined) {
    update.taskId = params.taskId;
  }

  if (params.slackChannelId !== undefined) {
    update.slackChannelId = params.slackChannelId;
  }

  if (params.threadTs !== undefined) {
    update.threadTs = params.threadTs;
  }

  const [run] = await tx
    .update(backgroundAutomationRuns)
    .set(update)
    .where(eq(backgroundAutomationRuns.id, params.runId))
    .returning({
      id: backgroundAutomationRuns.id,
    });

  return run ?? null;
}

export async function updateBackgroundAutomationRunArtifactsByTaskId(
  tx: DatabaseOrTransaction,
  params: {
    taskId: string;
  } & RunArtifactPatch,
) {
  const [existing] = await tx
    .select({
      id: backgroundAutomationRuns.id,
      metadata: backgroundAutomationRuns.metadata,
    })
    .from(backgroundAutomationRuns)
    .where(eq(backgroundAutomationRuns.taskId, params.taskId))
    .orderBy(desc(backgroundAutomationRuns.createdAt))
    .limit(1);

  if (!existing) {
    return null;
  }

  return updateBackgroundAutomationRunArtifactsById(tx, {
    runId: existing.id,
    taskId: params.taskId,
    slackChannelId: params.slackChannelId,
    threadTs: params.threadTs,
    metadata: params.metadata,
  });
}

export async function completeBackgroundAutomationRun(
  tx: DatabaseOrTransaction,
  params: {
    runId: string;
    automationKey: BackgroundAutomationKey;
    status: TerminalRunStatus;
    finishedAt: Date;
    error?: string | null;
    lastRunAt?: Date | 'skip';
  } & RunArtifactPatch,
) {
  await updateBackgroundAutomationRunArtifactsById(tx, {
    runId: params.runId,
    taskId: params.taskId,
    slackChannelId: params.slackChannelId,
    threadTs: params.threadTs,
    metadata: params.metadata,
  });

  await tx
    .update(backgroundAutomationRuns)
    .set({
      status: params.status,
      finishedAt: params.finishedAt,
      error:
        params.status === 'failed'
          ? params.error?.trim() || 'Automation run failed.'
          : null,
      updatedAt: params.finishedAt,
    })
    .where(eq(backgroundAutomationRuns.id, params.runId));

  await tx
    .update(backgroundAutomations)
    .set(
      buildBackgroundAutomationCompletionUpdate({
        status: params.status,
        finishedAt: params.finishedAt,
        error: params.error,
        lastRunAt: params.lastRunAt,
      }),
    )
    .where(eq(backgroundAutomations.automationKey, params.automationKey));
}

export async function completeBackgroundAutomationRunByJobId(
  tx: DatabaseOrTransaction,
  params: {
    automationKey: BackgroundAutomationKey;
    bullmqJobId: string;
    status: TerminalRunStatus;
    finishedAt: Date;
    error?: string | null;
    lastRunAt?: Date | 'skip';
  } & RunArtifactPatch,
) {
  const [existing] = await tx
    .select({
      id: backgroundAutomationRuns.id,
    })
    .from(backgroundAutomationRuns)
    .where(
      and(
        eq(backgroundAutomationRuns.automationKey, params.automationKey),
        eq(backgroundAutomationRuns.bullmqJobId, params.bullmqJobId),
      ),
    )
    .limit(1);

  if (!existing) {
    return null;
  }

  await completeBackgroundAutomationRun(tx, {
    runId: existing.id,
    automationKey: params.automationKey,
    status: params.status,
    finishedAt: params.finishedAt,
    error: params.error,
    lastRunAt: params.lastRunAt,
    taskId: params.taskId,
    slackChannelId: params.slackChannelId,
    threadTs: params.threadTs,
    metadata: params.metadata,
  });

  return existing;
}

export async function listRecentBackgroundAutomationRuns(params: {
  automationKeys?: BackgroundAutomationKey[];
  limit?: number;
}) {
  return db
    .select({
      id: backgroundAutomationRuns.id,
      automationKey: backgroundAutomationRuns.automationKey,
      bullmqJobId: backgroundAutomationRuns.bullmqJobId,
      triggerKind: backgroundAutomationRuns.triggerKind,
      status: backgroundAutomationRuns.status,
      taskId: backgroundAutomationRuns.taskId,
      slackChannelId: backgroundAutomationRuns.slackChannelId,
      threadTs: backgroundAutomationRuns.threadTs,
      startedAt: backgroundAutomationRuns.startedAt,
      finishedAt: backgroundAutomationRuns.finishedAt,
      error: backgroundAutomationRuns.error,
      metadata: backgroundAutomationRuns.metadata,
      createdAt: backgroundAutomationRuns.createdAt,
      updatedAt: backgroundAutomationRuns.updatedAt,
    })
    .from(backgroundAutomationRuns)
    .where(
      and(
        params.automationKeys && params.automationKeys.length > 0
          ? inArray(
              backgroundAutomationRuns.automationKey,
              params.automationKeys,
            )
          : undefined,
      ),
    )
    .orderBy(desc(backgroundAutomationRuns.createdAt))
    .limit(params.limit ?? 50);
}
