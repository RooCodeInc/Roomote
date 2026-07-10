import {
  type TaskPayload,
  activeRunStatuses,
  TaskPayloadKind,
  ORPHANED_PENDING_THRESHOLD_MS,
  populateSnapshotResumeSlackMetadata,
  EXPIRED_SNAPSHOT_RESUME_ERROR,
  isSnapshotResumable,
  resolveComputeProviderTarget,
} from '@roomote/types';
import type { ModalClient as _ModalSdkClient } from 'modal';
import { enqueueCloudTask } from '@roomote/cloud-agents/server';
import { createComputeProviderClient } from '@roomote/compute-providers/factory';
import { createClient } from '@roomote/sdk/client';
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
import { createJobToken } from '@roomote/auth';
import {
  type ComputeProvider,
  isSnapshotCapableComputeProvider,
} from '@roomote/types';

import type { UserAuthSuccess } from '@/types';

import { Env } from '@/lib/server';
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
  | { success: true; cloudJobId: number; taskId: string }
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

async function findActiveEnvironmentSnapshotJob(params: {
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

    const activeRefreshJob = await findActiveEnvironmentSnapshotJob({
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
        cloudJobId: activeRefreshJob.id,
        taskId: activeRefreshJob.taskId,
      };
    }

    try {
      const snapshotLaunch = await enqueueCloudTask({
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
        cloudJobId: snapshotLaunch.id,
        taskId: snapshotLaunch.taskId,
      };
    } catch (error) {
      const activeRefreshJobAfterEnqueueError =
        await findActiveEnvironmentSnapshotJob({
          environmentId: input.environmentId,
          provider,
        });

      if (activeRefreshJobAfterEnqueueError) {
        return {
          success: true,
          cloudJobId: activeRefreshJobAfterEnqueueError.id,
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

export async function createCloudJobSnapshotCommand(
  auth: UserAuthSuccess,
  input: { cloudJobId: number },
): Promise<SimpleResult> {
  try {
    const { userId } = auth;

    const cloudJob = await db.query.taskRuns.findFirst({
      where: eq(taskRuns.id, input.cloudJobId),
    });

    if (!cloudJob) {
      return { success: false, error: 'Cloud job not found' };
    }

    if (!cloudJob.machineId) {
      return { success: false, error: 'No machine associated with this job' };
    }

    const provider = resolveComputeProviderTarget(cloudJob.vendor);
    const computeClient = createComputeProviderClient({ provider });

    if (!computeClient.capabilities.supportsSnapshots) {
      return {
        success: false,
        error: `Snapshots are not supported for ${provider} jobs`,
      };
    }

    const { status } = await computeClient.getInstanceStatus({
      instanceId: cloudJob.machineId,
    });

    if (status !== 'running') {
      return {
        success: false,
        error: `Cannot create snapshot: instance is ${status}`,
      };
    }

    if (cloudJob.snapshotId) {
      return { success: false, error: 'Snapshot already exists for this job' };
    }

    if (cloudJob.snapshotFailedAt) {
      return {
        success: false,
        error: 'A previous snapshot attempt failed for this job',
      };
    }

    const authToken = await createJobToken({
      cloudJobId: input.cloudJobId,
      userId,
      timeoutMs: 5 * 60 * 1000,
    });

    const client = createClient({
      url: Env.TRPC_URL,
      headers: () => ({ Authorization: `Bearer ${authToken}` }),
    });

    const { enqueued } = await client.cloudJobs.createSnapshot.mutate({
      cloudJobId: input.cloudJobId,
      sandboxId: cloudJob.machineId,
    });

    if (!enqueued) {
      return { success: false, error: 'Snapshot creation already requested' };
    }

    await db
      .update(taskRuns)
      .set({ snapshotRequestedAt: new Date() })
      .where(eq(taskRuns.id, input.cloudJobId));

    return { success: true };
  } catch (error) {
    console.error('createCloudJobSnapshot error:', error);

    try {
      await db
        .update(taskRuns)
        .set({
          snapshotRequestedAt: null,
          snapshotFailedAt: new Date(),
          error: `Snapshot creation failed: ${error instanceof Error ? error.message : String(error)}`,
        })
        .where(eq(taskRuns.id, input.cloudJobId));
    } catch (_error) {
      // NO-OP
    }

    return error instanceof Error
      ? { success: false, error: error.message }
      : { success: false, error: 'An unknown error occurred.' };
  }
}

export async function restoreCloudJobSnapshotCommand(
  auth: UserAuthSuccess,
  input: {
    sourceSnapshotId: string;
    sourceCloudJobId: number;
    clientMessageId?: string;
    description?: string;
    resumePrompt?: string;
    resumePromptImages?: string[];
  },
): Promise<SnapshotResult> {
  let outOfBandContext: ClaimedOutOfBandContext | null = null;

  try {
    const { userId } = auth;

    const sourceJob = await db.query.taskRuns.findFirst({
      where: eq(taskRuns.id, input.sourceCloudJobId),
      columns: {
        port: true,
        payload: true,
        taskId: true,
        snapshotCreatedAt: true,
        sourceRunId: true,
        vendor: true,
      },
    });

    if (!sourceJob) {
      return {
        success: false,
        error: 'Source cloud job not found or you do not have access',
      };
    }

    // Conversation cargo (draft prompt, Slack/Linear channel bindings) lives
    // on the tasks row.
    const sourceTask = await db.query.tasks.findFirst({
      where: eq(tasks.id, sourceJob.taskId),
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

    if (!isSnapshotResumable(sourceJob.snapshotCreatedAt)) {
      return {
        success: false,
        error: EXPIRED_SNAPSHOT_RESUME_ERROR,
      };
    }

    if (!sourceJob.payload?.repo && !sourceJob.payload?.environmentId) {
      return {
        success: false,
        error: 'Source cloud job has no workspace information',
      };
    }

    const sourcePayload = sourceJob.payload as Record<string, unknown>;

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
    if (resumePrompt.length > 0 && sourceJob.taskId) {
      outOfBandContext = await claimOutOfBandContextForPrompt(sourceJob.taskId);
    }

    const payload: TaskPayload<typeof TaskPayloadKind.SnapshotResume> = {
      repo: sourceJob.payload.repo,
      environmentId: sourceJob.payload.environmentId,
      port: sourceJob.port ?? undefined,
      sourceSnapshotId: input.sourceSnapshotId,
      sourceCloudJobId: input.sourceCloudJobId,
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
      sourceJob.payload,
      sourceJob.sourceRunId,
    );

    const resumeLaunch = await enqueueCloudTask({
      task: {
        computeProvider:
          sourceJob.vendor ?? resolveComputeProviderTarget(undefined),
        sourceSnapshotId: input.sourceSnapshotId,
        sourceCloudJobId: input.sourceCloudJobId,
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
        .where(eq(tasks.id, sourceJob.taskId));
    }

    return {
      success: true,
      cloudJobId: resumeLaunch.id,
      taskId: resumeLaunch.taskId,
    };
  } catch (error) {
    console.error('restoreCloudJobSnapshot error:', error);

    await releaseOutOfBandContext(outOfBandContext);

    return error instanceof Error
      ? { success: false, error: error.message }
      : { success: false, error: 'An unknown error occurred.' };
  }
}
