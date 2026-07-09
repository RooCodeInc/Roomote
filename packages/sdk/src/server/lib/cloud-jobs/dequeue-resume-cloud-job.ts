import {
  type AuthTokenContext,
  type JobTokenContext,
  type CloudTaskPayload,
  type RequestedWorkKind,
  CloudTaskStatus,
  TaskPayloadKind,
  resolveSourceControlProviderFromPayload,
} from '@roomote/types';
import {
  type CloudJob,
  type Task,
  db,
  taskRuns,
  recordJobLifecycleEvent,
  recordSnapshotResumeEvent,
  eq,
} from '@roomote/db/server';
import { releaseCloudTask } from '@roomote/cloud-agents/server';

import { updateCloudJob } from './update-cloud-job';
import {
  type GitAuthor,
  claimJobById,
  fetchEnvVars,
  fetchResolvedRuntimeEnvVars,
  cancelAndReleaseCloudJob,
  createSourceControlTokenForJob,
  type SourceControlRuntimeToken,
  cancelCloudJob,
  reportBootstrapFailure,
  resolveGitAuthor,
} from './dequeue-helpers';
import {
  type DequeuedTaskContext,
  buildDequeuedTaskContext,
} from './dequeue-cloud-job';
import { resolveSlackJobRouting } from './slack-job-routing';

type DequeueResumeCloudJobResult =
  | undefined
  | {
      cloudJob: CloudJob;
      task: DequeuedTaskContext;
      requestedWorkKind: RequestedWorkKind;
      gitHubToken: string;
      sourceControlToken: SourceControlRuntimeToken;
      envVars: Record<string, string>;
      harnessInstructions?: string;
      orgAgentInstructions?: string;
      styleGuidance?: string;
      setupOnboardingTask: boolean;
      gitAuthor: GitAuthor;
      /**
       * The Roomote harness session ID that should be resumed.
       * Resolved from tasks.harnessSessionId of the run's own task — resume
       * runs share the task with the run they resume.
       */
      harnessSessionId: string;
      /**
       * The repo from the source cloud job's payload.
       * Used to determine the correct workspace path.
       */
      sourceRepo?: string;
      /**
       * The environment ID from the source cloud job's payload.
       * If present, the workspace should be prepared in environment mode.
       */
      sourceEnvironmentId?: string;
      /**
       * Optional repository subset copied from the source cloud job payload.
       * Used to restore a scoped multi-repository workspace on resume.
       */
      sourceSelectedRepositories?: string[];
    };

/**
 * Prepares a snapshot-resume run for execution.
 *
 * This function claims the run, validates it, and reads the persisted
 * harnessSessionId from the run's task (resume runs are rows on the same
 * task). The worker uses that harness session ID to resume the existing task
 * instead of starting a new one.
 *
 * Unlike regular dequeue, this doesn't generate a prompt since we're resuming
 * an existing task with its own conversation history.
 *
 * @param _auth - Authentication context
 * @param input - Must include cloudJobId for the snapshot-resume run
 * @returns The run data with harnessSessionId, or undefined if preparation failed
 */
export const dequeueResumeCloudJob = async (
  _auth: AuthTokenContext | JobTokenContext,
  input: {
    cloudJobId: number;
    workerReleaseTag?: string;
    workerVersion?: string;
    workerCommit?: string;
  },
  {
    onBootstrapFailure,
  }: {
    onBootstrapFailure?: (error: Error, cloudJob: CloudJob) => void;
  } = {},
): Promise<DequeueResumeCloudJobResult> => {
  const tag = '[dequeueResumeCloudJob]';

  try {
    const { cloudJobId, workerReleaseTag, workerVersion, workerCommit } = input;
    const query = claimJobById(cloudJobId);

    type SnapshotResumeBootstrapEvent = {
      cloudJobId: number;
      taskId?: string;
      message: string;
      details: Record<string, unknown>;
    };

    type TransactionResult =
      | {
          error: true;
          cloudJob?: CloudJob;
          bootstrapFailureEvent?: SnapshotResumeBootstrapEvent;
        }
      | {
          error: false;
          cloudJob: CloudJob;
          task: Task;
          envVars: Record<string, string>;
          orgAgentInstructions?: string;
          styleGuidance?: string;
          gitAuthor: GitAuthor;
          harnessSessionId: string;
          sourceRepo?: string;
          sourceEnvironmentId?: string;
          sourceSelectedRepositories?: string[];
        };

    const result: TransactionResult = await db.transaction(async (tx) => {
      const [dequeued] = await tx.execute<Pick<CloudJob, 'id'>>(query);

      const cloudJob = dequeued
        ? await tx.query.taskRuns.findFirst({
            where: eq(taskRuns.id, dequeued.id),
            with: { task: true },
          })
        : undefined;

      if (!cloudJob) {
        console.error(
          `${tag} Cloud job not found: ${JSON.stringify(dequeued)}`,
        );

        return { error: true, cloudJob };
      }

      if (cloudJob.payloadKind !== TaskPayloadKind.SnapshotResume) {
        const errorMessage = `Expected SnapshotResume run, got ${cloudJob.payloadKind}`;

        console.error(
          `${tag} Expected SnapshotResume run, got ${cloudJob.payloadKind}`,
        );

        reportBootstrapFailure({
          callback: onBootstrapFailure,
          error: new Error(errorMessage),
          cloudJob,
          logPrefix: tag,
        });

        const bootstrapFailureEvent: SnapshotResumeBootstrapEvent = {
          cloudJobId: cloudJob.id,
          taskId: cloudJob.taskId,
          message:
            'Snapshot resume bootstrap failed because the claimed run was not a snapshot-resume run.',
          details: {
            stage: 'bootstrap',
            reason: 'invalid_job_type',
            actualJobType: cloudJob.payloadKind,
          },
        };

        await cancelCloudJob(tx, cloudJob.id, errorMessage, {
          bootstrapFailureReason: 'invalid_job_type',
          existingArtifacts: cloudJob.artifacts,
        });

        return { error: true, cloudJob, bootstrapFailureEvent };
      }

      const resumePayload = cloudJob.payload as CloudTaskPayload<
        typeof TaskPayloadKind.SnapshotResume
      >;
      const sourceRunId =
        cloudJob.sourceRunId ?? resumePayload.sourceCloudJobId;

      if (!sourceRunId) {
        const errorMessage = `Snapshot-resume run ${cloudJob.id} has no source run id`;

        console.error(`${tag} ${errorMessage}`);

        reportBootstrapFailure({
          callback: onBootstrapFailure,
          error: new Error(errorMessage),
          cloudJob,
          logPrefix: tag,
        });

        const bootstrapFailureEvent: SnapshotResumeBootstrapEvent = {
          cloudJobId: cloudJob.id,
          taskId: cloudJob.taskId,
          message:
            'Snapshot resume bootstrap failed because the run was missing its source run id.',
          details: {
            stage: 'bootstrap',
            reason: 'missing_source_cloud_job_id',
            sourceSnapshotId: cloudJob.sourceSnapshotId ?? null,
          },
        };

        await cancelCloudJob(tx, cloudJob.id, errorMessage, {
          bootstrapFailureReason: 'missing_source_cloud_job_id',
          existingArtifacts: cloudJob.artifacts,
        });

        return { error: true, cloudJob, bootstrapFailureEvent };
      }

      // Resume runs share their task with the run they resume, so the
      // harness session lives on the run's own task row.
      const harnessSessionId = cloudJob.task.harnessSessionId ?? null;

      if (!harnessSessionId) {
        console.error(
          `${tag} Task ${cloudJob.taskId} for resume run ${cloudJob.id} has no harnessSessionId`,
        );

        reportBootstrapFailure({
          callback: onBootstrapFailure,
          error: new Error(
            `Task ${cloudJob.taskId} for resume run ${cloudJob.id} has no harnessSessionId to resume`,
          ),
          cloudJob,
          logPrefix: tag,
        });

        const bootstrapFailureEvent: SnapshotResumeBootstrapEvent = {
          cloudJobId: cloudJob.id,
          taskId: cloudJob.taskId,
          message:
            'Snapshot resume bootstrap failed because the task had no harness session to resume.',
          details: {
            stage: 'bootstrap',
            reason: 'missing_harness_session_id',
            sourceRunId,
            sourceSnapshotId: resumePayload.sourceSnapshotId,
            sourceTaskId: cloudJob.taskId,
          },
        };

        await cancelCloudJob(
          tx,
          cloudJob.id,
          `Task ${cloudJob.taskId} for resume run ${cloudJob.id} has no harnessSessionId to resume`,
          {
            bootstrapFailureReason: 'missing_harness_session_id',
            existingArtifacts: cloudJob.artifacts,
          },
        );

        return { error: true, cloudJob, bootstrapFailureEvent };
      }

      // Get repo and environmentId from the current run's payload.
      // These were copied from the source run when the resume was created.
      const sourceRepo = resumePayload.repo;
      const sourceEnvironmentId = resumePayload.environmentId;
      const sourceSelectedRepositories = resumePayload.selectedRepositories;
      console.log(
        `${tag} Found harness session ID ${harnessSessionId} for resume run ${cloudJob.id} (taskId=${cloudJob.taskId}, sourceRunId=${sourceRunId}, repo=${sourceRepo}, environmentId=${sourceEnvironmentId})`,
      );

      // Fetch environment variables
      const envVars = await fetchEnvVars(tx, {
        sourceControlProvider: resolveSourceControlProviderFromPayload(
          cloudJob.payload,
        ),
      });
      const settings = await tx.query.backgroundAgentSettings.findFirst({
        columns: {
          globalAgentInstructions: true,
          styleGuidance: true,
        },
      });

      // Update startedAt timestamp
      await tx
        .update(taskRuns)
        .set({
          startedAt: new Date(),
          ...(workerReleaseTag !== undefined ? { workerReleaseTag } : {}),
          ...(workerVersion !== undefined ? { workerVersion } : {}),
          ...(workerCommit !== undefined ? { workerCommit } : {}),
        })
        .where(eq(taskRuns.id, cloudJob.id));

      await recordJobLifecycleEvent(tx, {
        runId: cloudJob.id,
        taskId: cloudJob.taskId,
        eventType: 'started',
        message:
          'Worker claimed dequeued snapshot-resume job and started resume bootstrap.',
        details: {
          stage: 'worker_bootstrap',
          status: CloudTaskStatus.Processing,
          vendor: cloudJob.vendor ?? null,
          machineId: cloudJob.machineId ?? null,
          sourceSnapshotId: cloudJob.sourceSnapshotId ?? null,
          sourceRunId,
          harnessSessionId,
          sourceRepo,
          sourceEnvironmentId,
          selectedRepositories: sourceSelectedRepositories ?? null,
          cloudTaskType: cloudJob.payloadKind,
          workerReleaseTag: workerReleaseTag ?? null,
          workerVersion: workerVersion ?? null,
          workerCommit: workerCommit ?? null,
        },
      });

      const gitAuthor = await resolveGitAuthor(tx, cloudJob);

      return {
        error: false,
        cloudJob,
        task: cloudJob.task,
        envVars,
        orgAgentInstructions: settings?.globalAgentInstructions ?? undefined,
        styleGuidance: settings?.styleGuidance ?? undefined,
        gitAuthor,
        harnessSessionId,
        sourceRepo,
        sourceEnvironmentId,
        sourceSelectedRepositories,
      };
    });

    if (result.error) {
      const { cloudJob } = result;

      if (result.bootstrapFailureEvent) {
        await recordSnapshotResumeBootstrapEvent({
          cloudJobId: result.bootstrapFailureEvent.cloudJobId,
          taskId: result.bootstrapFailureEvent.taskId,
          eventType: 'failed',
          message: result.bootstrapFailureEvent.message,
          details: result.bootstrapFailureEvent.details,
        });
      }

      if (cloudJob) {
        try {
          await releaseCloudTask(cloudJob);
        } catch (error) {
          console.error(
            `${tag} Failed to release lock for job ${cloudJob.id}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }

      return undefined;
    }

    // Create source-control token OUTSIDE the transaction so retries with
    // exponential backoff don't hold the row lock open.
    const sourceControlProvider = resolveSourceControlProviderFromPayload(
      result.cloudJob.payload,
    );
    const sourceControlToken = await createSourceControlTokenForJob(
      result.cloudJob,
      tag,
    );

    if (!sourceControlToken) {
      await recordSnapshotResumeBootstrapEvent({
        cloudJobId: result.cloudJob.id,
        taskId: result.cloudJob.taskId,
        eventType: 'failed',
        message:
          'Snapshot resume bootstrap failed because the source control token could not be created.',
        details: {
          stage: 'bootstrap',
          reason: 'missing_source_control_token',
          provider: sourceControlProvider,
          sourceRunId: result.cloudJob.sourceRunId ?? null,
          sourceSnapshotId: result.cloudJob.sourceSnapshotId ?? null,
        },
      });

      await cancelAndReleaseCloudJob(
        result.cloudJob,
        'Failed to create source control token.',
        tag,
      );

      return undefined;
    }

    const gitHubToken =
      sourceControlToken.provider === 'github' ? sourceControlToken.token : '';

    let resolvedEnvVars: Record<string, string>;

    try {
      resolvedEnvVars = await fetchResolvedRuntimeEnvVars(result.envVars, {
        sourceControlProvider: sourceControlToken.provider,
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Failed to resolve harness runtime credentials.';

      await recordSnapshotResumeBootstrapEvent({
        cloudJobId: result.cloudJob.id,
        taskId: result.cloudJob.taskId,
        eventType: 'failed',
        message:
          'Snapshot resume bootstrap failed because runtime credentials could not be resolved.',
        details: {
          stage: 'bootstrap',
          reason: 'runtime_env_resolution_failed',
          sourceRunId: result.cloudJob.sourceRunId ?? null,
          sourceSnapshotId: result.cloudJob.sourceSnapshotId ?? null,
          error: message,
        },
      });

      await cancelAndReleaseCloudJob(result.cloudJob, message, tag);
      return undefined;
    }

    result.envVars = { ...resolvedEnvVars, ...sourceControlToken.envVars };

    await recordSnapshotResumeBootstrapEvent({
      cloudJobId: result.cloudJob.id,
      taskId: result.cloudJob.taskId,
      eventType: 'started',
      message: `Snapshot resume bootstrap started with source session ${result.harnessSessionId}.`,
      details: {
        stage: 'bootstrap',
        sourceRunId: result.cloudJob.sourceRunId ?? null,
        sourceSnapshotId: result.cloudJob.sourceSnapshotId ?? null,
        harnessSessionId: result.harnessSessionId,
        sourceRepo: result.sourceRepo ?? null,
        sourceEnvironmentId: result.sourceEnvironmentId ?? null,
        selectedRepositories: result.sourceSelectedRepositories ?? [],
      },
    });

    const existingArtifacts =
      result.cloudJob.artifacts &&
      typeof result.cloudJob.artifacts === 'object' &&
      !Array.isArray(result.cloudJob.artifacts)
        ? (result.cloudJob.artifacts as Record<string, unknown>)
        : {};

    // Fire-and-forget update of non-critical fields
    updateCloudJob(result.cloudJob.id, {
      prompt: '', // No prompt for resume tasks
      artifacts: {
        ...existingArtifacts,
        ...(sourceControlToken.artifactsPatch ?? {}),
      },
    });

    const slackJobRouting = await resolveSlackJobRouting(result.cloudJob);

    const { error: _, task, ...rest } = result;
    return {
      ...rest,
      task: buildDequeuedTaskContext(task),
      requestedWorkKind: task.requestedWorkKind,
      gitHubToken,
      sourceControlToken,
      orgAgentInstructions: result.orgAgentInstructions,
      styleGuidance: result.styleGuidance,
      setupOnboardingTask: slackJobRouting.route.kind === 'setup-onboarding',
      harnessInstructions: task.harnessInstructions ?? undefined,
    };
  } catch (error) {
    console.error(
      `${tag} Caught error: ${error instanceof Error ? error.message : String(error)}`,
    );
    throw error;
  }
};

async function recordSnapshotResumeBootstrapEvent(input: {
  cloudJobId: number;
  taskId?: string;
  eventType: 'started' | 'failed';
  message: string;
  details: Record<string, unknown>;
}): Promise<void> {
  try {
    await recordSnapshotResumeEvent(db, {
      runId: input.cloudJobId,
      taskId: input.taskId,
      eventType: input.eventType,
      message: input.message,
      details: input.details,
    });
  } catch (error) {
    console.warn(
      `[dequeueResumeCloudJob] Failed to persist snapshot resume event for job ${input.cloudJobId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
