import {
  type TaskPayload,
  activeRunStatuses,
  runningRunStatuses,
  TaskPayloadKind,
  ORPHANED_PENDING_THRESHOLD_MS,
  populateSnapshotResumeSlackMetadata,
  EXPIRED_SNAPSHOT_RESUME_ERROR,
  isTaskResumeCapableComputeProvider,
  isResumableTaskPayloadKind,
  isSnapshotResumable,
  resolveComputeProviderTarget,
} from '@roomote/types';
import type { ModalClient as _ModalSdkClient } from 'modal';
import { enqueueTask } from '@roomote/cloud-agents/server';
import { enqueueTaskSleep } from '@roomote/sdk/server';
import {
  db,
  environments,
  taskRuns,
  tasks,
  claimPendingEnvironmentSnapshotForAttachment,
  clearEnvironmentSnapshot,
  getEnvironmentSnapshot,
  upsertEnvironmentSnapshot,
  updatePendingEnvironmentSnapshot,
  resolveDefaultComputeProvider,
  desc,
  eq,
  and,
  inArray,
  isNull,
  sql,
} from '@roomote/db/server';
import {
  type ComputeProvider,
  isSnapshotCapableComputeProvider,
} from '@roomote/types';

import type { UserAuthSuccess } from '@/types';

import {
  type ClaimedOutOfBandContext,
  claimOutOfBandContextForPrompt,
  releaseOutOfBandContext,
  withOutOfBandContext,
} from '@/lib/server/out-of-band-context';
import { restoreSnapshotResumeVisiblePromptFields } from '../snapshot-visible-prompt';

// The web app's server routes can instantiate Modal compute clients through
// @roomote/compute-providers, so the app package keeps an explicit type-level
// dependency on the Modal SDK.
type _ModalSdkDependency = _ModalSdkClient;

type SnapshotResult =
  | { success: true; runId: number; taskId: string }
  | { success: false; error: string };

type SimpleResult = { success: true } | { success: false; error: string };

async function inheritSnapshotResumeVisiblePromptFields(
  payload: Record<string, unknown>,
  sourcePayload: unknown,
  ancestorSourceRunId: number | null,
): Promise<void> {
  restoreSnapshotResumeVisiblePromptFields(payload, sourcePayload);

  const visited = new Set<number>();
  let currentSourceRunId = ancestorSourceRunId;

  while (currentSourceRunId && !visited.has(currentSourceRunId)) {
    visited.add(currentSourceRunId);

    const sourceRun = await db.query.taskRuns.findFirst({
      where: eq(taskRuns.id, currentSourceRunId),
      columns: {
        payload: true,
        sourceRunId: true,
      },
    });

    if (!sourceRun) {
      return;
    }

    restoreSnapshotResumeVisiblePromptFields(payload, sourceRun.payload);
    currentSourceRunId = sourceRun.sourceRunId;
  }
}

async function findActiveEnvironmentSnapshotRun(params: {
  environmentId: string;
  provider: ComputeProvider;
}) {
  const [job] = await db
    .select({
      id: taskRuns.id,
      taskId: taskRuns.taskId,
    })
    .from(taskRuns)
    .innerJoin(tasks, eq(tasks.id, taskRuns.taskId))
    .where(
      and(
        eq(tasks.workflow, 'env_snapshot'),
        eq(taskRuns.vendor, params.provider),
        inArray(taskRuns.status, [...activeRunStatuses]),
        sql`${taskRuns.payload}->>'environmentId' = ${params.environmentId}`,
      ),
    )
    .orderBy(desc(taskRuns.createdAt), desc(taskRuns.id))
    .limit(1);

  return job ?? null;
}

export async function createEnvironmentSnapshotCommand(
  auth: UserAuthSuccess,
  input: { environmentId: string; provider?: ComputeProvider },
): Promise<SnapshotResult> {
  try {
    const { userId } = auth;
    const provider = resolveComputeProviderTarget(
      input.provider,
      await resolveDefaultComputeProvider(),
    );

    if (!auth.isAdmin) {
      throw new Error('Unauthorized');
    }

    if (!isSnapshotCapableComputeProvider(provider)) {
      return {
        success: false,
        error: `Environment snapshots are not supported for ${provider} jobs`,
      };
    }

    const [environment] = await db
      .select()
      .from(environments)
      .where(
        and(
          eq(environments.id, input.environmentId),
          isNull(environments.userId),
        ),
      )
      .limit(1);

    if (!environment) {
      return { success: false, error: 'Environment not found' };
    }

    const existingSnapshot = await getEnvironmentSnapshot({
      environmentId: environment.id,
      provider,
    });

    const claimAttemptedAt = new Date();
    const pendingSnapshotClaim =
      await claimPendingEnvironmentSnapshotForAttachment(db, {
        environmentId: input.environmentId,
        provider,
        updatedAt: claimAttemptedAt,
        allowStalePendingBefore: new Date(
          claimAttemptedAt.getTime() - ORPHANED_PENDING_THRESHOLD_MS,
        ),
      });

    if (!pendingSnapshotClaim) {
      return {
        success: false,
        error: 'Snapshot creation already in progress',
      };
    }

    const activeRefreshJob = await findActiveEnvironmentSnapshotRun({
      environmentId: input.environmentId,
      provider,
    });

    if (activeRefreshJob) {
      if (existingSnapshot) {
        await upsertEnvironmentSnapshot(db, {
          environmentId: input.environmentId,
          provider,
          snapshotId: existingSnapshot.snapshotId,
          snapshotStatus: existingSnapshot.snapshotStatus,
          snapshotCreatedAt: existingSnapshot.snapshotCreatedAt,
          snapshotExpiresAt: existingSnapshot.snapshotExpiresAt,
        });
      } else {
        await clearEnvironmentSnapshot(db, {
          environmentId: input.environmentId,
          provider,
        });
      }

      return {
        success: true,
        runId: activeRefreshJob.id,
        taskId: activeRefreshJob.taskId,
      };
    }

    try {
      const snapshotLaunch = await enqueueTask({
        task: {
          computeProvider: provider,
          type: TaskPayloadKind.SnapshotEnvironment,
          payload: {
            repo: '',
            environmentId: input.environmentId,
            environmentSnapshotAttachment:
              pendingSnapshotClaim.attachmentSource,
          },
        },
        initiator: { kind: 'user', userId },
        workflow: 'env_snapshot',
        surface: 'web',
        trigger: 'manual',
        visibility: 'hidden',
      });

      return {
        success: true,
        runId: snapshotLaunch.id,
        taskId: snapshotLaunch.taskId,
      };
    } catch (error) {
      const activeRefreshJobAfterEnqueueError =
        await findActiveEnvironmentSnapshotRun({
          environmentId: input.environmentId,
          provider,
        });

      if (activeRefreshJobAfterEnqueueError) {
        return {
          success: true,
          runId: activeRefreshJobAfterEnqueueError.id,
          taskId: activeRefreshJobAfterEnqueueError.taskId,
        };
      }

      await updatePendingEnvironmentSnapshot(db, {
        environmentId: input.environmentId,
        provider,
        snapshotId: null,
        snapshotStatus: 'failed',
        snapshotCreatedAt: null,
        snapshotExpiresAt: null,
        attachmentSource: pendingSnapshotClaim.attachmentSource,
      });

      throw error;
    }
  } catch (error) {
    console.error('createEnvironmentSnapshot error:', error);

    return error instanceof Error
      ? { success: false, error: error.message }
      : { success: false, error: 'An unknown error occurred.' };
  }
}

export async function clearEnvironmentSnapshotCommand(
  auth: UserAuthSuccess,
  input: { environmentId: string; provider?: ComputeProvider },
): Promise<SimpleResult> {
  try {
    const provider = resolveComputeProviderTarget(
      input.provider,
      await resolveDefaultComputeProvider(),
    );

    if (!auth.isAdmin) {
      throw new Error('Unauthorized');
    }

    const [environment] = await db
      .select()
      .from(environments)
      .where(
        and(
          eq(environments.id, input.environmentId),
          isNull(environments.userId),
        ),
      )
      .limit(1);

    if (!environment) {
      return { success: false, error: 'Environment not found' };
    }

    await clearEnvironmentSnapshot(db, {
      environmentId: input.environmentId,
      provider,
    });

    return { success: true };
  } catch (error) {
    console.error('clearEnvironmentSnapshot error:', error);

    return error instanceof Error
      ? { success: false, error: error.message }
      : { success: false, error: 'An unknown error occurred.' };
  }
}

export async function requestTaskRunSleepCommand(
  _auth: UserAuthSuccess,
  input: { runId: number },
): Promise<SimpleResult> {
  try {
    const taskRun = await db.query.taskRuns.findFirst({
      where: eq(taskRuns.id, input.runId),
    });

    if (!taskRun) {
      return { success: false, error: 'Task run not found' };
    }

    if (!taskRun.machineId) {
      return { success: false, error: 'No machine associated with this job' };
    }

    const provider = resolveComputeProviderTarget(taskRun.vendor);

    if (
      !isTaskResumeCapableComputeProvider(provider) ||
      !isResumableTaskPayloadKind(taskRun.payloadKind)
    ) {
      return {
        success: false,
        error: `Resumable sleep is not supported for this ${provider} task`,
      };
    }

    if (!runningRunStatuses.some((status) => status === taskRun.status)) {
      return {
        success: false,
        error: 'Only active task runs can be put to sleep',
      };
    }

    if (taskRun.snapshotId) {
      return { success: false, error: 'This task is already asleep' };
    }

    if (taskRun.snapshotFailedAt) {
      return {
        success: false,
        error: 'A previous sleep attempt failed for this task',
      };
    }

    await enqueueTaskSleep({ runId: input.runId });

    return { success: true };
  } catch (error) {
    console.error('requestTaskRunSleep error:', error);

    return error instanceof Error
      ? { success: false, error: error.message }
      : { success: false, error: 'An unknown error occurred.' };
  }
}

export async function restoreTaskRunSnapshotCommand(
  auth: UserAuthSuccess,
  input: {
    sourceSnapshotId: string;
    sourceRunId: number;
    clientMessageId?: string;
    description?: string;
    resumePrompt?: string;
    resumePromptImages?: string[];
  },
): Promise<SnapshotResult> {
  let outOfBandContext: ClaimedOutOfBandContext | null = null;

  try {
    const { userId } = auth;

    const sourceRun = await db.query.taskRuns.findFirst({
      where: eq(taskRuns.id, input.sourceRunId),
      columns: {
        port: true,
        payload: true,
        taskId: true,
        snapshotCreatedAt: true,
        sourceRunId: true,
        vendor: true,
      },
    });

    if (!sourceRun) {
      return {
        success: false,
        error: 'Source task run not found or you do not have access',
      };
    }

    // Conversation cargo (draft prompt, Slack/Linear channel bindings) lives
    // on the tasks row.
    const sourceTask = await db.query.tasks.findFirst({
      where: eq(tasks.id, sourceRun.taskId),
      columns: {
        draftPrompt: true,
        slackChannelId: true,
        slackThreadTs: true,
        linearSessionId: true,
        linearIssueId: true,
        linearOrganizationId: true,
      },
    });

    if (!sourceTask) {
      return {
        success: false,
        error: 'Source task not found or you do not have access',
      };
    }

    if (!isSnapshotResumable(sourceRun.snapshotCreatedAt)) {
      return {
        success: false,
        error: EXPIRED_SNAPSHOT_RESUME_ERROR,
      };
    }

    if (!sourceRun.payload?.repo && !sourceRun.payload?.environmentId) {
      return {
        success: false,
        error: 'Source task run has no workspace information',
      };
    }

    const sourcePayload = sourceRun.payload as Record<string, unknown>;

    const explicitResumePrompt = input.resumePrompt;
    const hasExplicitResumePrompt = typeof explicitResumePrompt === 'string';
    const resumePrompt = hasExplicitResumePrompt
      ? explicitResumePrompt.trim()
      : '';
    const resumePromptImages = Array.isArray(input.resumePromptImages)
      ? input.resumePromptImages.filter(
          (image): image is string =>
            typeof image === 'string' && image.length > 0,
        )
      : undefined;

    // Re-surface messages posted to the task while it was idle (e.g. PR
    // review-feedback notifications) — they are in the transcript but not in
    // the harness session, so the resumed agent would otherwise have no idea
    // what the user's reply refers to.
    if (resumePrompt.length > 0 && sourceRun.taskId) {
      outOfBandContext = await claimOutOfBandContextForPrompt(sourceRun.taskId);
    }

    const payload: TaskPayload<typeof TaskPayloadKind.SnapshotResume> = {
      repo: sourceRun.payload.repo,
      environmentId: sourceRun.payload.environmentId,
      port: sourceRun.port ?? undefined,
      sourceSnapshotId: input.sourceSnapshotId,
      sourceRunId: input.sourceRunId,
      ...(resumePrompt.length > 0
        ? {
            resumePrompt: withOutOfBandContext(outOfBandContext, resumePrompt),
            resumePromptSource: 'web',
            resumePromptUserId: userId,
            ...(typeof input.clientMessageId === 'string' &&
            input.clientMessageId.trim().length > 0
              ? { resumePromptClientMessageId: input.clientMessageId.trim() }
              : {}),
            ...(resumePromptImages?.length ? { resumePromptImages } : {}),
          }
        : {}),
    };
    populateSnapshotResumeSlackMetadata(payload, {
      sourcePayload,
      threadTs: sourceTask.slackThreadTs,
    });

    await inheritSnapshotResumeVisiblePromptFields(
      payload,
      sourceRun.payload,
      sourceRun.sourceRunId,
    );

    const resumeLaunch = await enqueueTask({
      task: {
        computeProvider:
          sourceRun.vendor ?? resolveComputeProviderTarget(undefined),
        sourceSnapshotId: input.sourceSnapshotId,
        sourceRunId: input.sourceRunId,
        type: TaskPayloadKind.SnapshotResume,
        ...(sourceTask.slackThreadTs
          ? { slackThreadTs: sourceTask.slackThreadTs }
          : {}),
        ...(sourceTask.linearSessionId
          ? {
              linearSessionId: sourceTask.linearSessionId,
              ...(sourceTask.linearIssueId
                ? { linearIssueId: sourceTask.linearIssueId }
                : {}),
              ...(sourceTask.linearOrganizationId
                ? { linearOrganizationId: sourceTask.linearOrganizationId }
                : {}),
            }
          : {}),
        payload,
      },
      actingUserId: userId,
    });

    if (hasExplicitResumePrompt && resumePrompt.length === 0) {
      await db
        .update(tasks)
        .set({ draftPrompt: null })
        .where(eq(tasks.id, sourceRun.taskId));
    }

    return {
      success: true,
      runId: resumeLaunch.id,
      taskId: resumeLaunch.taskId,
    };
  } catch (error) {
    console.error('restoreTaskRunSnapshot error:', error);

    await releaseOutOfBandContext(outOfBandContext);

    return error instanceof Error
      ? { success: false, error: error.message }
      : { success: false, error: 'An unknown error occurred.' };
  }
}
