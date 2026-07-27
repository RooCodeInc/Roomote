import * as path from 'node:path';

import {
  RunStatus,
  type SourceControlTokenMetadata,
  type TaskPayloadKind,
  WORKER_HEARTBEAT_INTERVAL_MS,
  buildRoomoteDeployMarker,
  formatRoomoteDeployMarker,
  resolveTaskWorkspace,
  resolveComputeProviderTarget,
  resolveSourceControlProviderFromPayload,
} from '@roomote/types';
import { type TaskRun, sdk } from '@roomote/sdk/client';

import { WorkerEnv } from '../../env';
import {
  type HarnessLogger,
  createStartupLogger,
  createHarnessLogger,
  HARNESS_LOG_FILE_NAME,
} from '../../logging';
import type { WorkspaceConfig } from '../../workspace';
import type { RepoLocalSkill } from '../../workspace/repo-local-skills';
import { callbackMap } from '../../callbacks';
import {
  getCommunicationRunTaskCallbacks,
  mergeRunTaskCallbacks,
} from '../../callbacks/communication';
import type { RunTaskCallbacks, RunTaskContext } from '../../run-task';
import type { BackgroundEnvironmentSetupNotifier } from '../../run-task/types';
import { createWorkerRuntimeEventRecorder } from '../../run-task/task-run-events';
import { createWorkerHeartbeatInterval } from '../../run-task/polling/worker-heartbeat';
import { createComputeProviderUsageInterval } from '../../run-task/polling/compute-provider-usage';
import { captureWorkerException } from '../../monitoring/sentry';
import {
  clearWorkerRuntimeContext,
  setWorkerRuntimeContext,
} from '../../monitoring/runtime-context';
import type { WorkerReleaseMetadata } from '../../monitoring/worker-release-metadata';
import { resolveWorkerReleaseMetadata } from '../../monitoring/worker-release-metadata';

import { type SetupMode, setup } from '../setup';
import {
  type RepositoryPreparationIssue,
  type WorkspaceRepositoryPreparationContinued,
  type WorkspaceRepositoryPreparationFailure,
  WorkspaceRepositoryPreparationError,
} from '../setup/workspace/types';

import { BackgroundEnvironmentSetupController } from './background-environment-setup-controller';
import { injectEnvVars, writeBashrc } from './env-vars';
import { buildServiceContextForPreviewProxy } from './service-context';
import { finalizeJob, handleTaskRunError } from './task-run-lifecycle';

interface PreparedTaskRunBase {
  taskRun: TaskRun;
  envVars: Record<string, string>;
  sourceControlToken?: SourceControlTokenMetadata;
  gitAuthor?: { name: string; email: string };
  setupOnboardingTask?: boolean;
}

interface ExecuteTaskRunConfig<TJobContext extends PreparedTaskRunBase> {
  runId: number;
  setupMode: SetupMode;
  preserveGitState?: boolean;
  fetchFn: (
    runId: number,
    workerReleaseMetadata: WorkerReleaseMetadata,
  ) => Promise<TJobContext | undefined>;
  workspaceConfigFn: (jobContext: TJobContext) => Promise<WorkspaceConfig>;
  runFn: (params: {
    jobContext: TJobContext;
    /**
     * Snapshot of the dequeue-provided env vars taken before injectEnvVars
     * adds runtime-internal entries. This is the operator-owned set.
     */
    userEnvVars: Record<string, string | undefined>;
    workspace: WorkspaceConfig;
    workspacePath: string;
    usesSharedWorkspaceRoot: boolean;
    repoPaths?: Record<string, string>;
    repoLocalSkills?: RepoLocalSkill[];
    workspaceReadinessWarnings?: string[];
    backgroundEnvironmentSetup: BackgroundEnvironmentSetupNotifier;
    cancelSignal: AbortSignal;
    callbacks: RunTaskCallbacks;
    context: RunTaskContext;
    logger: HarnessLogger;
    workerEnv: WorkerEnv;
  }) => Promise<{
    status: RunStatus;
    error?: string;
  }>;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function recordWorkerPhase<T>(input: {
  label: string;
  recordWorkerRuntimeEvent: ReturnType<typeof createWorkerRuntimeEventRecorder>;
  details?: Record<string, unknown>;
  fn: () => Promise<T>;
}): Promise<T> {
  const startedAtMs = Date.now();

  try {
    const result = await input.fn();
    const endedAtMs = Date.now();

    await input.recordWorkerRuntimeEvent({
      eventType: 'phase',
      message: input.label,
      details: {
        phase: input.label,
        startedAtMs,
        endedAtMs,
        durationMs: endedAtMs - startedAtMs,
        outcome: 'ok',
        ...(input.details ?? {}),
      },
    });

    return result;
  } catch (error) {
    const endedAtMs = Date.now();

    await input.recordWorkerRuntimeEvent({
      eventType: 'phase',
      message: input.label,
      details: {
        phase: input.label,
        startedAtMs,
        endedAtMs,
        durationMs: endedAtMs - startedAtMs,
        outcome: 'failed',
        error: describeError(error),
        ...(input.details ?? {}),
      },
    });

    throw error;
  }
}

function serializeRepositoryPreparationIssues(
  issues: RepositoryPreparationIssue[],
) {
  return issues.map((item) => ({
    repository: item.repository,
    reason: item.reason,
    diagnostics: item.diagnostics ?? null,
  }));
}

function buildRepositoryPreparationEventInput(params: {
  taskRun: TaskRun;
  outcome:
    | WorkspaceRepositoryPreparationContinued
    | WorkspaceRepositoryPreparationFailure;
}) {
  const { taskRun, outcome } = params;
  const skippedOrFailedCount = outcome.repositories.length;
  const preparedRepositoryCount = outcome.preparedRepositoryCount;
  const action =
    outcome.mode === 'continued'
      ? `Skipped ${skippedOrFailedCount} repositor${
          skippedOrFailedCount === 1 ? 'y' : 'ies'
        } during ${outcome.workspaceType} workspace setup and continued with ${preparedRepositoryCount} prepared repositor${
          preparedRepositoryCount === 1 ? 'y' : 'ies'
        }`
      : `Workspace setup failed while preparing repositories for the ${outcome.workspaceType} workspace after ${preparedRepositoryCount} successful repositor${
          preparedRepositoryCount === 1 ? 'y' : 'ies'
        }`;

  return {
    eventType: 'failed' as const,
    message: `${action} for task run #${taskRun.id}.`,
    details: {
      reason: 'workspace_repository_prepare_failed',
      failureMode: outcome.mode,
      workspaceType: outcome.workspaceType,
      payloadKind: taskRun.payloadKind,
      totalRepositories: outcome.totalRepositories,
      preparedRepositoryCount,
      failedRepositoryCount: skippedOrFailedCount,
      failedRepositories: serializeRepositoryPreparationIssues(
        outcome.repositories,
      ),
    },
  };
}

function hasSnapshotLifecycleActivity(job: {
  sleepRequestedAt?: Date | null;
  snapshotRequestedAt?: Date | null;
  snapshotCreatedAt?: Date | null;
  snapshotFailedAt?: Date | null;
}): boolean {
  return Boolean(
    job.sleepRequestedAt ||
    job.snapshotRequestedAt ||
    job.snapshotCreatedAt ||
    job.snapshotFailedAt,
  );
}

function isSetupOnboardingTask(params: {
  taskRun: TaskRun;
  jobContext: PreparedTaskRunBase;
}): boolean {
  const { taskRun, jobContext } = params;

  if (jobContext.setupOnboardingTask !== undefined) {
    return jobContext.setupOnboardingTask;
  }

  const payload =
    taskRun.payload && typeof taskRun.payload === 'object'
      ? (taskRun.payload as { webPath?: unknown })
      : null;

  return payload?.webPath === '/setup';
}

function shouldRunParallelTaskEnvironmentSetup(params: {
  taskRun: TaskRun;
  jobContext: PreparedTaskRunBase;
  setupMode: SetupMode;
  workspace: WorkspaceConfig;
}): boolean {
  const { taskRun, jobContext, setupMode, workspace } = params;

  return (
    setupMode === 'full' &&
    workspace.type === 'environment' &&
    !isSetupOnboardingTask({ taskRun, jobContext })
  );
}

async function shouldSuppressFinalizeError(params: {
  taskRun: TaskRun;
  result: {
    status: RunStatus;
    error?: string;
  };
  error: unknown;
  logger: HarnessLogger;
}): Promise<boolean> {
  const { taskRun, result, error, logger } = params;

  if (result.status === RunStatus.Failed || result.status === RunStatus.Idle) {
    return false;
  }

  let latestRun: TaskRun | undefined;

  try {
    latestRun = await sdk.taskRuns.findFirstById(taskRun.id);
  } catch (lookupError) {
    logger.warn(
      `[executeTaskRun] Failed to inspect latest task run state after finalization error for task run ${taskRun.id}: ${describeError(lookupError)}`,
    );

    return false;
  }

  if (!latestRun) {
    return false;
  }

  const statusAlreadyPersisted =
    latestRun.status === RunStatus.Completed ||
    latestRun.status === RunStatus.Canceled;

  const snapshotOwnedPostRunState =
    latestRun.status === RunStatus.Idle &&
    hasSnapshotLifecycleActivity(latestRun);

  if (!statusAlreadyPersisted && !snapshotOwnedPostRunState) {
    return false;
  }

  const latestStatus = latestRun.status;
  const message = describeError(error);

  logger.warn(
    `[executeTaskRun] Suppressing non-fatal post-run finalization error for task run ${taskRun.id}: ${message} (latest status: ${latestStatus})`,
  );

  captureWorkerException(error, {
    runId: taskRun.id,
    stage: 'executeTaskRun.suppressedFinalizeError',
    latestStatus,
    snapshotRequestedAt: latestRun.snapshotRequestedAt?.toISOString() ?? null,
    snapshotCreatedAt: latestRun.snapshotCreatedAt?.toISOString() ?? null,
    snapshotFailedAt: latestRun.snapshotFailedAt?.toISOString() ?? null,
  });

  return true;
}

export async function executeTaskRun<TPrepared extends PreparedTaskRunBase>({
  runId,
  setupMode,
  preserveGitState,
  fetchFn,
  workspaceConfigFn,
  runFn,
}: ExecuteTaskRunConfig<TPrepared>): Promise<boolean> {
  let taskRun: TaskRun | undefined = undefined;
  let harnessLogger: HarnessLogger | undefined = undefined;
  let workerHeartbeatInterval: NodeJS.Timeout | undefined = undefined;

  let workerComputeUsageLoop:
    | ReturnType<typeof createComputeProviderUsageInterval>
    | undefined = undefined;

  let callbacks: RunTaskCallbacks = {};
  let startupLogger = createStartupLogger();
  let workerEnv: WorkerEnv | undefined = undefined;
  let backgroundEnvironmentSetupController =
    new BackgroundEnvironmentSetupController({
      recordWorkerRuntimeEvent: async () => undefined,
    });

  const context: RunTaskContext = {};
  const workerReleaseMetadata = resolveWorkerReleaseMetadata();
  setWorkerRuntimeContext({ runId });

  try {
    const jobContext = await fetchFn(runId, workerReleaseMetadata);

    if (!jobContext) {
      startupLogger.debug.log('Failed to fetch job context');
      return false;
    }

    const { envVars } = jobContext;
    taskRun = jobContext.taskRun;
    const runIdForEvents = taskRun.id;
    callbacks = mergeRunTaskCallbacks(
      callbackMap[taskRun.payloadKind as TaskPayloadKind] ?? {},
      getCommunicationRunTaskCallbacks(taskRun),
    );

    workerEnv = WorkerEnv.fromProcessEnv(process.env);
    startupLogger = createStartupLogger();
    startupLogger.setFilePath(path.resolve('/tmp', HARNESS_LOG_FILE_NAME));
    startupLogger.debug.info(
      formatRoomoteDeployMarker(
        buildRoomoteDeployMarker({
          service: 'worker',
          overrides: {
            roomote_app_env: workerEnv.appEnv,
            roomote_release: workerReleaseMetadata.sentryRelease,
            roomote_release_source: workerReleaseMetadata.workerReleaseTag
              ? 'worker_release_tag'
              : workerReleaseMetadata.workerCommit
                ? 'worker_commit'
                : undefined,
            roomote_worker_release_tag: workerReleaseMetadata.workerReleaseTag,
            roomote_worker_version: workerReleaseMetadata.workerVersion,
            roomote_worker_commit: workerReleaseMetadata.workerCommit,
          },
        }),
      ),
    );

    const recordWorkerRuntimeEvent = createWorkerRuntimeEventRecorder({
      runId: runIdForEvents,
      logger: startupLogger.debug,
    });
    backgroundEnvironmentSetupController =
      new BackgroundEnvironmentSetupController({
        taskRun,
        recordWorkerRuntimeEvent,
      });

    // Snapshot user-specified DB env vars before injectEnvVars mutates the
    // object with system-level entries.
    const userEnvVars = { ...envVars };

    // Worker config values are read once here so their captured values
    // (auth keys, API URLs) can be reused throughout setup and runtime.
    const taskWorkspace = resolveTaskWorkspace(taskRun.payload);

    const environmentId =
      taskWorkspace.type === 'environment'
        ? taskWorkspace.environmentId
        : undefined;

    setWorkerRuntimeContext({
      runId: taskRun.id,
      taskRunType: taskRun.payloadKind,
      environmentId,
      taskId: taskRun.taskId,
    });

    const envVarKeys = Object.keys(envVars);

    startupLogger.debug.log(
      `[executeTaskRun] Job context envVars: ${envVarKeys.length} keys${envVarKeys.length > 0 ? ` [${envVarKeys.join(', ')}]` : ''}`,
    );

    await injectEnvVars(envVars, taskRun, {
      previewProxyBaseUrl: workerEnv.previewProxyBaseUrl,
      previewProxySubdomainSuffix: workerEnv.previewProxySubdomainSuffix,
      sourceControlToken: jobContext.sourceControlToken,
    });

    if (taskRun.canceledAt) {
      await backgroundEnvironmentSetupController.flush();
      startupLogger.debug.log('Task is already canceled, exiting');
      await callbacks.onExit?.(taskRun, RunStatus.Canceled, context);
      return true;
    }

    workerHeartbeatInterval = createWorkerHeartbeatInterval({
      runId: runIdForEvents,
      taskId: taskRun.taskId,
      logger: {
        ...startupLogger.debug,
        warn: (message: string) => {
          startupLogger.debug.warn(message);
          void recordWorkerRuntimeEvent({
            eventType: 'failed',
            message: `Worker heartbeat update failed for task run #${runIdForEvents}.`,
            details: {
              reason: 'worker_heartbeat_update_failed',
              heartbeatIntervalMs: WORKER_HEARTBEAT_INTERVAL_MS,
              warning: message,
            },
          });
        },
      },
    });

    await recordWorkerRuntimeEvent({
      eventType: 'started',
      message: `Started worker heartbeat loop for task run #${runIdForEvents}.`,
      details: { heartbeatIntervalMs: WORKER_HEARTBEAT_INTERVAL_MS },
    });

    workerComputeUsageLoop = createComputeProviderUsageInterval({
      runId: runIdForEvents,
      computeProvider: resolveComputeProviderTarget(taskRun.vendor),
      logger: {
        ...startupLogger.debug,
        warn: (message: string) => {
          startupLogger.debug.warn(message);

          void recordWorkerRuntimeEvent({
            eventType: 'failed',
            message: `Compute usage update failed for task run #${runIdForEvents}.`,
            details: {
              reason: 'compute_provider_usage_update_failed',
              computeUsageIntervalMs: WORKER_HEARTBEAT_INTERVAL_MS,
              warning: message,
            },
          });
        },
      },
      recordDiagnosticEvent: async (input) => {
        await recordWorkerRuntimeEvent({
          eventType: 'decision',
          message: input.message,
          details: input.details,
        });
      },
    });

    await recordWorkerRuntimeEvent({
      eventType: 'started',
      message: `Started compute usage loop for task run #${runIdForEvents}.`,
      details: { computeUsageIntervalMs: WORKER_HEARTBEAT_INTERVAL_MS },
    });

    await sdk.taskRuns.update({
      id: taskRun.id,
      status: RunStatus.Preparing,
    });

    const workspace = await recordWorkerPhase({
      label: 'resolveWorkspaceConfig',
      recordWorkerRuntimeEvent,
      details: {
        payloadKind: taskRun.payloadKind,
        setupMode,
      },
      fn: async () => await workspaceConfigFn(jobContext),
    });

    workerEnv.setRuntimeEnv(envVars);

    const serviceContext = buildServiceContextForPreviewProxy(
      taskRun,
      workspace,
      workerEnv,
    );

    const runEnvironmentSetupInBackground =
      shouldRunParallelTaskEnvironmentSetup({
        taskRun,
        jobContext,
        setupMode,
        workspace,
      });

    const currentTaskRun = taskRun;
    const currentWorkerEnv = workerEnv;

    const {
      preparedWorkspace,
      backgroundEnvironmentSetup: backgroundEnvironmentSetupPromise,
    } = await recordWorkerPhase({
      label: 'setupWorkspace',
      recordWorkerRuntimeEvent,
      details: {
        payloadKind: taskRun.payloadKind,
        setupMode,
        workspaceType: workspace.type,
        backgroundEnvironmentSetup: runEnvironmentSetupInBackground,
      },
      fn: async () =>
        await setup({
          mode: setupMode,
          workspace: {
            workspace,
            envVars,
            userEnvVars,
            harness: currentTaskRun.harness,
            taskRunType: currentTaskRun.payloadKind,
            preserveGitState,
            serviceContext,
            sourceControlProvider: resolveSourceControlProviderFromPayload(
              currentTaskRun.payload,
            ),
            gitAuthorName: jobContext.gitAuthor?.name,
            gitAuthorEmail: jobContext.gitAuthor?.email,
          },
          logger: startupLogger,
          workerEnv: currentWorkerEnv,
          backgroundEnvironmentSetup: runEnvironmentSetupInBackground,
          recordPhase: ({
            label,
            startedAtMs,
            endedAtMs,
            durationMs,
            outcome,
          }) =>
            recordWorkerRuntimeEvent({
              eventType: 'phase',
              message: label,
              details: {
                phase: label,
                startedAtMs,
                endedAtMs,
                durationMs,
                outcome,
                setupMode,
              },
            }),
        }),
    });
    backgroundEnvironmentSetupController =
      new BackgroundEnvironmentSetupController({
        taskRun,
        backgroundSetupPromise: backgroundEnvironmentSetupPromise,
        recordWorkerRuntimeEvent,
      });

    const workspacePath = preparedWorkspace?.workspacePath;

    const usesSharedWorkspaceRoot =
      preparedWorkspace?.usesSharedWorkspaceRoot ?? false;
    const repoPaths = preparedWorkspace?.repoPaths;
    const repoLocalSkills = preparedWorkspace?.repoLocalSkills;

    if (taskRun && preparedWorkspace?.repositoryPreparationOutcome) {
      await recordWorkerRuntimeEvent(
        buildRepositoryPreparationEventInput({
          taskRun,
          outcome: preparedWorkspace.repositoryPreparationOutcome,
        }),
      );
    }

    if (
      taskRun &&
      preparedWorkspace?.environmentSetupWarnings &&
      preparedWorkspace.environmentSetupWarnings.length > 0
    ) {
      const warningMessages = preparedWorkspace.environmentSetupWarnings.map(
        (warning) => warning.message,
      );

      await recordWorkerRuntimeEvent({
        eventType: 'decision',
        message: `Continuing task run #${taskRun.id} after environment setup warnings.`,
        details: {
          reason: 'environment_setup_warning',
          warnings: warningMessages,
        },
      });
    }

    if (!workspacePath) {
      throw new Error('Setup did not return a workspace path');
    }

    // Stamp setupCompletedAt immediately after setup() returns. Only-if-null
    // semantics inside the stamp helper guarantee we capture the first
    // transition even if the worker retries or replays this path.
    await sdk.taskRuns.stampMilestone({
      runId: taskRun.id,
      field: 'setupCompletedAt',
    });

    // setupCompletedAt only marks the blocking portion of setup; environment
    // setup may keep running in the background. Track its real lifecycle so
    // the UI can distinguish "setup still running" from "setup done" after
    // the agent starts. The controller writes the terminal state on settle.
    if (workspace.type === 'environment') {
      try {
        if (backgroundEnvironmentSetupPromise) {
          await sdk.taskRuns.updateEnvironmentSetup({
            runId: taskRun.id,
            state: 'running',
          });
        } else {
          const setupWarningCount =
            preparedWorkspace?.environmentSetupWarnings?.length ?? 0;

          await sdk.taskRuns.updateEnvironmentSetup({
            runId: taskRun.id,
            state:
              setupWarningCount > 0 ? 'completed_with_warnings' : 'completed',
            completedAt: new Date(),
          });
        }
      } catch (error) {
        startupLogger.debug.warn(
          `Failed to persist environment setup state for task run ${taskRun.id}: ${describeError(error)}`,
        );
      }
    }

    writeBashrc(workerEnv.buildUserFacingEnv());

    if (taskRun.canceledAt) {
      await backgroundEnvironmentSetupController.flush();
      startupLogger.debug.log('Task is already canceled, exiting');
      await callbacks.onExit?.(taskRun, RunStatus.Canceled, context);
      return true;
    }

    harnessLogger = createHarnessLogger(taskRun.id, {
      logToConsole: false,
    });

    await backgroundEnvironmentSetupController.preflightTaskStart();

    const runTaskPromise = runFn({
      jobContext,
      userEnvVars,
      workspace,
      workspacePath,
      usesSharedWorkspaceRoot,
      repoPaths,
      repoLocalSkills,
      workspaceReadinessWarnings:
        preparedWorkspace?.environmentSetupWarnings?.map(
          (warning) => warning.message,
        ),
      backgroundEnvironmentSetup: backgroundEnvironmentSetupController,
      cancelSignal: backgroundEnvironmentSetupController.cancelSignal,
      callbacks,
      context,
      logger: harnessLogger,
      workerEnv,
    });
    const result =
      await backgroundEnvironmentSetupController.runTask(runTaskPromise);

    await backgroundEnvironmentSetupController.flush();

    try {
      await finalizeJob({
        result,
        taskRun,
        logger: harnessLogger,
        callbacks,
        context,
      });
    } catch (error) {
      if (
        harnessLogger &&
        (await shouldSuppressFinalizeError({
          taskRun,
          result,
          error,
          logger: harnessLogger,
        }))
      ) {
        return true;
      }

      throw error;
    }

    return true;
  } catch (error) {
    await backgroundEnvironmentSetupController.flush();

    if (taskRun && error instanceof WorkspaceRepositoryPreparationError) {
      const recordWorkerRuntimeEvent = createWorkerRuntimeEventRecorder({
        runId: taskRun.id,
        logger: startupLogger.debug,
      });

      await recordWorkerRuntimeEvent(
        buildRepositoryPreparationEventInput({
          taskRun,
          outcome: error.failure,
        }),
      );
    }

    const outcome = await handleTaskRunError({
      error,
      taskRun,
      logger: harnessLogger,
      callbacks,
      context,
    });

    return outcome !== 'failed';
  } finally {
    try {
      if (workerHeartbeatInterval) {
        clearInterval(workerHeartbeatInterval);

        if (taskRun) {
          const recordWorkerRuntimeEvent = createWorkerRuntimeEventRecorder({
            runId: taskRun.id,
            logger: startupLogger.debug,
          });

          await recordWorkerRuntimeEvent({
            eventType: 'completed',
            message: `Stopped worker heartbeat loop for task run #${taskRun.id}.`,
            details: { reason: 'worker_heartbeat_loop_stopped' },
          });
        }
      }

      if (workerComputeUsageLoop) {
        workerComputeUsageLoop.stop();
        await workerComputeUsageLoop.flush({ updateKind: 'shutdown_flush' });

        if (taskRun) {
          const recordWorkerRuntimeEvent = createWorkerRuntimeEventRecorder({
            runId: taskRun.id,
            logger: startupLogger.debug,
          });

          await recordWorkerRuntimeEvent({
            eventType: 'completed',
            message: `Stopped compute usage loop for task run #${taskRun.id}.`,
            details: { reason: 'compute_provider_usage_loop_stopped' },
          });
        }
      }
    } finally {
      clearWorkerRuntimeContext();
    }
  }
}
