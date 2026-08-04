import {
  type AuthTokenContext,
  type RunTokenContext,
  type TaskPayload,
  type RequestedWorkKind,
  RunStatus,
  TaskPayloadKind,
  isStandbyResumeCapableComputeProvider,
  resolveSourceControlProviderFromPayload,
} from '@roomote/types';
import {
  type TaskRun,
  type Task,
  db,
  taskRuns,
  recordTaskRunLifecycleEvent,
  recordSnapshotResumeEvent,
  eq,
} from '@roomote/db/server';
import { releaseTaskRun } from '@roomote/cloud-agents/server';

import { updateTaskRun } from './update-task-run';
import {
  type GitAuthor,
  claimJobById,
  fetchEnvVars,
  fetchResolvedRuntimeEnvVars,
  resolveTaskRunSourceControlProviders,
  cancelAndReleaseTaskRun,
  createSourceControlTokenForTaskRun,
  type SourceControlRuntimeToken,
  cancelTaskRun,
  notifyCanceledTaskRunOnSettle,
  reportBootstrapFailure,
  resolveGitAuthor,
} from './dequeue-helpers';
import {
  type DequeuedTaskContext,
  buildDequeuedTaskContext,
} from './dequeue-task-run';
import { resolveSlackTaskRunRouting } from './slack-task-run-routing';

type DequeueResumeTaskRunResult =
  | undefined
  | {
      taskRun: TaskRun;
      task: DequeuedTaskContext;
      requestedWorkKind: RequestedWorkKind;
      gitHubToken: string;
      sourceControlToken: SourceControlRuntimeToken;
      envVars: Record<string, string>;
      harnessInstructions?: string;
      orgAgentInstructions?: string;
      setupOnboardingTask: boolean;
      gitAuthor: GitAuthor;
      /**
       * The Roomote harness session ID that should be resumed, when one has
       * started. Retained standby environments can be suspended before their
       * first prompt creates a harness session.
       */
      harnessSessionId?: string;
      /**
       * The repo from the source task run's payload.
       * Used to determine the correct workspace path.
       */
      sourceRepo?: string;
      /**
       * The environment ID from the source task run's payload.
       * If present, the workspace should be prepared in environment mode.
       */
      sourceEnvironmentId?: string;
      /**
       * Optional repository subset copied from the source task run payload.
       * Used to restore a scoped multi-repository workspace on resume.
       */
      sourceSelectedRepositories?: string[];
    };

/**
 * Prepares a snapshot-resume run for execution.
 *
 * This function claims the run, validates it, and reads the persisted
 * harnessSessionId from the run's task (resume runs are rows on the same
 * task). The worker uses that harness session ID to resume an existing task.
 * Retained standby environments may legitimately have no session yet when
 * they were suspended before their first prompt.
 *
 * Unlike regular dequeue, this doesn't generate a prompt since we're resuming
 * an existing task with its own conversation history.
 *
 * @param _auth - Authentication context
 * @param input - Must include runId for the snapshot-resume run
 * @returns The run data with harnessSessionId, or undefined if preparation failed
 */
export const dequeueResumeTaskRun = async (
  _auth: AuthTokenContext | RunTokenContext,
  input: {
    runId: number;
    workerReleaseTag?: string;
    workerVersion?: string;
    workerCommit?: string;
  },
  {
    onBootstrapFailure,
  }: {
    onBootstrapFailure?: (error: Error, taskRun: TaskRun) => void;
  } = {},
): Promise<DequeueResumeTaskRunResult> => {
  const tag = '[dequeueResumeTaskRun]';

  try {
    const { runId, workerReleaseTag, workerVersion, workerCommit } = input;
    const query = claimJobById(runId);

    type SnapshotResumeBootstrapEvent = {
      runId: number;
      taskId?: string;
      message: string;
      details: Record<string, unknown>;
    };

    type TransactionResult =
      | {
          error: true;
          taskRun?: TaskRun;
          bootstrapFailureEvent?: SnapshotResumeBootstrapEvent;
        }
      | {
          error: false;
          taskRun: TaskRun;
          task: Task;
          envVars: Record<string, string>;
          orgAgentInstructions?: string;
          gitAuthor: GitAuthor;
          harnessSessionId?: string;
          sourceRepo?: string;
          sourceEnvironmentId?: string;
          sourceSelectedRepositories?: string[];
          sourceControlProviders: Awaited<
            ReturnType<typeof resolveTaskRunSourceControlProviders>
          >;
        };

    const result: TransactionResult = await db.transaction(async (tx) => {
      const [dequeued] = await tx.execute<Pick<TaskRun, 'id'>>(query);

      const taskRun = dequeued
        ? await tx.query.taskRuns.findFirst({
            where: eq(taskRuns.id, dequeued.id),
            with: { task: true },
          })
        : undefined;

      if (!taskRun) {
        console.error(`${tag} Task run not found: ${JSON.stringify(dequeued)}`);

        return { error: true, taskRun };
      }

      if (taskRun.payloadKind !== TaskPayloadKind.SnapshotResume) {
        const errorMessage = `Expected SnapshotResume run, got ${taskRun.payloadKind}`;

        console.error(
          `${tag} Expected SnapshotResume run, got ${taskRun.payloadKind}`,
        );

        reportBootstrapFailure({
          callback: onBootstrapFailure,
          error: new Error(errorMessage),
          taskRun,
          logPrefix: tag,
        });

        const bootstrapFailureEvent: SnapshotResumeBootstrapEvent = {
          runId: taskRun.id,
          taskId: taskRun.taskId,
          message:
            'Snapshot resume bootstrap failed because the claimed run was not a snapshot-resume run.',
          details: {
            stage: 'bootstrap',
            reason: 'invalid_run_kind',
            actualRunKind: taskRun.payloadKind,
          },
        };

        await cancelTaskRun(tx, taskRun.id, errorMessage, {
          bootstrapFailureReason: 'invalid_run_kind',
          existingArtifacts: taskRun.artifacts,
        });

        return { error: true, taskRun, bootstrapFailureEvent };
      }

      const resumePayload = taskRun.payload as TaskPayload<
        typeof TaskPayloadKind.SnapshotResume
      >;
      const sourceRunId = taskRun.sourceRunId ?? resumePayload.sourceRunId;

      if (!sourceRunId) {
        const errorMessage = `Snapshot-resume run ${taskRun.id} has no source run id`;

        console.error(`${tag} ${errorMessage}`);

        reportBootstrapFailure({
          callback: onBootstrapFailure,
          error: new Error(errorMessage),
          taskRun,
          logPrefix: tag,
        });

        const bootstrapFailureEvent: SnapshotResumeBootstrapEvent = {
          runId: taskRun.id,
          taskId: taskRun.taskId,
          message:
            'Snapshot resume bootstrap failed because the run was missing its source run id.',
          details: {
            stage: 'bootstrap',
            reason: 'missing_source_task_run_id',
            sourceSnapshotId: taskRun.sourceSnapshotId ?? null,
          },
        };

        await cancelTaskRun(tx, taskRun.id, errorMessage, {
          bootstrapFailureReason: 'missing_source_task_run_id',
          existingArtifacts: taskRun.artifacts,
        });

        return { error: true, taskRun, bootstrapFailureEvent };
      }

      // Resume runs share their task with the run they resume, so the
      // harness session lives on the run's own task row.
      const harnessSessionId = taskRun.task.harnessSessionId ?? null;
      const canResumeWithoutHarnessSession =
        isStandbyResumeCapableComputeProvider(taskRun.vendor);

      if (!harnessSessionId && !canResumeWithoutHarnessSession) {
        console.error(
          `${tag} Task ${taskRun.taskId} for resume run ${taskRun.id} has no harnessSessionId`,
        );

        reportBootstrapFailure({
          callback: onBootstrapFailure,
          error: new Error(
            `Task ${taskRun.taskId} for resume run ${taskRun.id} has no harnessSessionId to resume`,
          ),
          taskRun,
          logPrefix: tag,
        });

        const bootstrapFailureEvent: SnapshotResumeBootstrapEvent = {
          runId: taskRun.id,
          taskId: taskRun.taskId,
          message:
            'Snapshot resume bootstrap failed because the task had no harness session to resume.',
          details: {
            stage: 'bootstrap',
            reason: 'missing_harness_session_id',
            sourceRunId,
            sourceSnapshotId: resumePayload.sourceSnapshotId,
            sourceTaskId: taskRun.taskId,
          },
        };

        await cancelTaskRun(
          tx,
          taskRun.id,
          `Task ${taskRun.taskId} for resume run ${taskRun.id} has no harnessSessionId to resume`,
          {
            bootstrapFailureReason: 'missing_harness_session_id',
            existingArtifacts: taskRun.artifacts,
          },
        );

        return { error: true, taskRun, bootstrapFailureEvent };
      }

      // Get repo and environmentId from the current run's payload.
      // These were copied from the source run when the resume was created.
      const sourceRepo = resumePayload.repo;
      const sourceEnvironmentId = resumePayload.environmentId;
      const sourceSelectedRepositories = resumePayload.selectedRepositories;
      console.log(
        harnessSessionId
          ? `${tag} Found harness session ID ${harnessSessionId} for resume run ${taskRun.id} (taskId=${taskRun.taskId}, sourceRunId=${sourceRunId}, repo=${sourceRepo}, environmentId=${sourceEnvironmentId})`
          : `${tag} Resuming retained ${taskRun.vendor} environment for run ${taskRun.id} before its first harness session (taskId=${taskRun.taskId}, sourceRunId=${sourceRunId}, repo=${sourceRepo}, environmentId=${sourceEnvironmentId})`,
      );

      // Fetch environment variables
      const sourceControlProviders = await resolveTaskRunSourceControlProviders(
        taskRun,
        tx,
      );
      const envVars = await fetchEnvVars(tx, {
        sourceControlProvider: sourceControlProviders,
      });
      const settings = await tx.query.deploymentSettings.findFirst({
        columns: {
          globalAgentInstructions: true,
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
        .where(eq(taskRuns.id, taskRun.id));

      await recordTaskRunLifecycleEvent(tx, {
        runId: taskRun.id,
        taskId: taskRun.taskId,
        eventType: 'started',
        message:
          'Worker claimed dequeued snapshot-resume run and started resume bootstrap.',
        details: {
          stage: 'worker_bootstrap',
          status: RunStatus.Processing,
          vendor: taskRun.vendor ?? null,
          machineId: taskRun.machineId ?? null,
          sourceSnapshotId: taskRun.sourceSnapshotId ?? null,
          sourceRunId,
          harnessSessionId,
          sourceRepo,
          sourceEnvironmentId,
          selectedRepositories: sourceSelectedRepositories ?? null,
          payloadKind: taskRun.payloadKind,
          workerReleaseTag: workerReleaseTag ?? null,
          workerVersion: workerVersion ?? null,
          workerCommit: workerCommit ?? null,
        },
      });

      const gitAuthor = await resolveGitAuthor(tx, taskRun);

      return {
        error: false,
        taskRun,
        task: taskRun.task,
        envVars,
        orgAgentInstructions: settings?.globalAgentInstructions ?? undefined,
        gitAuthor,
        harnessSessionId: harnessSessionId ?? undefined,
        sourceRepo,
        sourceEnvironmentId,
        sourceSelectedRepositories,
        sourceControlProviders,
      };
    });

    if (result.error) {
      const { taskRun } = result;

      if (result.bootstrapFailureEvent) {
        await recordSnapshotResumeBootstrapEvent({
          runId: result.bootstrapFailureEvent.runId,
          taskId: result.bootstrapFailureEvent.taskId,
          eventType: 'failed',
          message: result.bootstrapFailureEvent.message,
          details: result.bootstrapFailureEvent.details,
        });
      }

      if (taskRun) {
        try {
          await releaseTaskRun(taskRun);
        } catch (error) {
          console.error(
            `${tag} Failed to release lock for run ${taskRun.id}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }

        await notifyCanceledTaskRunOnSettle(taskRun);
      }

      return undefined;
    }

    // Create source-control token OUTSIDE the transaction so retries with
    // exponential backoff don't hold the row lock open.
    const sourceControlProvider = resolveSourceControlProviderFromPayload(
      result.taskRun.payload,
    );
    const sourceControlToken = await createSourceControlTokenForTaskRun(
      result.taskRun,
      tag,
    );

    if (!sourceControlToken) {
      await recordSnapshotResumeBootstrapEvent({
        runId: result.taskRun.id,
        taskId: result.taskRun.taskId,
        eventType: 'failed',
        message:
          'Snapshot resume bootstrap failed because the source control token could not be created.',
        details: {
          stage: 'bootstrap',
          reason: 'missing_source_control_token',
          provider: sourceControlProvider,
          sourceRunId: result.taskRun.sourceRunId ?? null,
          sourceSnapshotId: result.taskRun.sourceSnapshotId ?? null,
        },
      });

      await cancelAndReleaseTaskRun(
        result.taskRun,
        'Failed to create source control token.',
        tag,
      );

      return undefined;
    }

    const gitHubToken = sourceControlToken.envVars.GH_TOKEN ?? '';

    let resolvedEnvVars: Record<string, string>;

    try {
      resolvedEnvVars = await fetchResolvedRuntimeEnvVars(result.envVars, {
        sourceControlProvider: result.sourceControlProviders,
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Failed to resolve harness runtime credentials.';

      await recordSnapshotResumeBootstrapEvent({
        runId: result.taskRun.id,
        taskId: result.taskRun.taskId,
        eventType: 'failed',
        message:
          'Snapshot resume bootstrap failed because runtime credentials could not be resolved.',
        details: {
          stage: 'bootstrap',
          reason: 'runtime_env_resolution_failed',
          sourceRunId: result.taskRun.sourceRunId ?? null,
          sourceSnapshotId: result.taskRun.sourceSnapshotId ?? null,
          error: message,
        },
      });

      await cancelAndReleaseTaskRun(result.taskRun, message, tag);
      return undefined;
    }

    result.envVars = { ...resolvedEnvVars, ...sourceControlToken.envVars };

    await recordSnapshotResumeBootstrapEvent({
      runId: result.taskRun.id,
      taskId: result.taskRun.taskId,
      eventType: 'started',
      message: result.harnessSessionId
        ? `Snapshot resume bootstrap started with source session ${result.harnessSessionId}.`
        : 'Standby resume bootstrap started before the first harness session.',
      details: {
        stage: 'bootstrap',
        sourceRunId: result.taskRun.sourceRunId ?? null,
        sourceSnapshotId: result.taskRun.sourceSnapshotId ?? null,
        harnessSessionId: result.harnessSessionId,
        sourceRepo: result.sourceRepo ?? null,
        sourceEnvironmentId: result.sourceEnvironmentId ?? null,
        selectedRepositories: result.sourceSelectedRepositories ?? [],
      },
    });

    const existingArtifacts =
      result.taskRun.artifacts &&
      typeof result.taskRun.artifacts === 'object' &&
      !Array.isArray(result.taskRun.artifacts)
        ? (result.taskRun.artifacts as Record<string, unknown>)
        : {};

    // Fire-and-forget update of non-critical fields
    updateTaskRun(result.taskRun.id, {
      prompt: '', // No prompt for resume tasks
      artifacts: {
        ...existingArtifacts,
        ...(sourceControlToken.artifactsPatch ?? {}),
      },
    });

    const slackTaskRunRouting = await resolveSlackTaskRunRouting(
      result.taskRun,
    );

    const { error: _, task, ...rest } = result;
    return {
      ...rest,
      task: buildDequeuedTaskContext(task),
      requestedWorkKind: task.requestedWorkKind,
      gitHubToken,
      sourceControlToken,
      orgAgentInstructions: result.orgAgentInstructions,
      setupOnboardingTask:
        slackTaskRunRouting.route.kind === 'setup-onboarding',
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
  runId: number;
  taskId?: string;
  eventType: 'started' | 'failed';
  message: string;
  details: Record<string, unknown>;
}): Promise<void> {
  try {
    await recordSnapshotResumeEvent(db, {
      runId: input.runId,
      taskId: input.taskId,
      eventType: input.eventType,
      message: input.message,
      details: input.details,
    });
  } catch (error) {
    console.warn(
      `[dequeueResumeTaskRun] Failed to persist snapshot resume event for run ${input.runId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
