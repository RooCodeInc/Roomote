import * as path from 'node:path';

import {
  CloudTaskStatus,
  type SourceControlTokenMetadata,
  WORKER_HEARTBEAT_INTERVAL_MS,
  buildRoomoteDeployMarker,
  formatRoomoteDeployMarker,
  resolveCloudTaskWorkspace,
  resolveComputeProviderTarget,
  resolveSourceControlProviderFromPayload,
} from '@roomote/types';
import { type CloudJob, sdk } from '@roomote/sdk/client';

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
import type { RunTaskCallbacks, RunTaskContext } from '../../run-task';
import { createWorkerRuntimeEventRecorder } from '../../run-task/cloud-job-events';
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
import { finalizeJob, handleJobError } from './job-lifecycle';

interface PreparedJobBase {
  cloudJob: CloudJob;
  envVars: Record<string, string>;
  sourceControlToken?: SourceControlTokenMetadata;
  gitAuthor?: { name: string; email: string };
  setupOnboardingTask?: boolean;
}

interface ExecuteJobConfig<TJobContext extends PreparedJobBase> {
  cloudJobId: number;
  setupMode: SetupMode;
  preserveGitState?: boolean;
  fetchFn: (
    cloudJobId: number,
    workerReleaseMetadata: WorkerReleaseMetadata,
  ) => Promise<TJobContext | undefined>;
  workspaceConfigFn: (jobContext: TJobContext) => Promise<WorkspaceConfig>;
  runFn: (params: {
    jobContext: TJobContext;
    workspace: WorkspaceConfig;
    workspacePath: string;
    usesSharedWorkspaceRoot: boolean;
    repoPaths?: Record<string, string>;
    repoLocalSkills?: RepoLocalSkill[];
    workspaceReadinessWarnings?: string[];
    cancelSignal: AbortSignal;
    callbacks: RunTaskCallbacks;
    context: RunTaskContext;
    logger: HarnessLogger;
    workerEnv: WorkerEnv;
  }) => Promise<{
    status: CloudTaskStatus;
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
  cloudJob: CloudJob;
  outcome:
    | WorkspaceRepositoryPreparationContinued
    | WorkspaceRepositoryPreparationFailure;
}) {
  const { cloudJob, outcome } = params;
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
    message: `${action} for cloud job #${cloudJob.id}.`,
    details: {
      reason: 'workspace_repository_prepare_failed',
      failureMode: outcome.mode,
      workspaceType: outcome.workspaceType,
      cloudTaskType: cloudJob.type,
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
  cloudJob: CloudJob;
  jobContext: PreparedJobBase;
}): boolean {
  const { cloudJob, jobContext } = params;

  if (jobContext.setupOnboardingTask !== undefined) {
    return jobContext.setupOnboardingTask;
  }

  const payload =
    cloudJob.payload && typeof cloudJob.payload === 'object'
      ? (cloudJob.payload as { webPath?: unknown })
      : null;

  return payload?.webPath === '/setup';
}

function shouldRunParallelTaskEnvironmentSetup(params: {
  cloudJob: CloudJob;
  jobContext: PreparedJobBase;
  setupMode: SetupMode;
  workspace: WorkspaceConfig;
}): boolean {
  const { cloudJob, jobContext, setupMode, workspace } = params;

  return (
    setupMode === 'full' &&
    workspace.type === 'environment' &&
    !isSetupOnboardingTask({ cloudJob, jobContext })
  );
}

async function shouldSuppressFinalizeError(params: {
  cloudJob: CloudJob;
  result: {
    status: CloudTaskStatus;
    error?: string;
  };
  error: unknown;
  logger: HarnessLogger;
}): Promise<boolean> {
  const { cloudJob, result, error, logger } = params;

  if (
    result.status === CloudTaskStatus.Failed ||
    result.status === CloudTaskStatus.Idle
  ) {
    return false;
  }

  let latestJob: CloudJob | undefined;

  try {
    latestJob = await sdk.cloudJobs.findFirstById(cloudJob.id);
  } catch (lookupError) {
    logger.warn(
      `[executeJob] Failed to inspect latest cloud job state after finalization error for cloud job ${cloudJob.id}: ${describeError(lookupError)}`,
    );

    return false;
  }

  if (!latestJob) {
    return false;
  }

  const statusAlreadyPersisted =
    latestJob.status === CloudTaskStatus.Completed ||
    latestJob.status === CloudTaskStatus.Canceled;

  const snapshotOwnedPostRunState =
    latestJob.status === CloudTaskStatus.Idle &&
    hasSnapshotLifecycleActivity(latestJob);

  if (!statusAlreadyPersisted && !snapshotOwnedPostRunState) {
    return false;
  }

  const latestStatus = latestJob.status;
  const message = describeError(error);

  logger.warn(
    `[executeJob] Suppressing non-fatal post-run finalization error for cloud job ${cloudJob.id}: ${message} (latest status: ${latestStatus})`,
  );

  captureWorkerException(error, {
    cloudJobId: cloudJob.id,
    stage: 'executeJob.suppressedFinalizeError',
    latestStatus,
    snapshotRequestedAt: latestJob.snapshotRequestedAt?.toISOString() ?? null,
    snapshotCreatedAt: latestJob.snapshotCreatedAt?.toISOString() ?? null,
    snapshotFailedAt: latestJob.snapshotFailedAt?.toISOString() ?? null,
  });

  return true;
}

export async function executeJob<TPrepared extends PreparedJobBase>({
  cloudJobId,
  setupMode,
  preserveGitState,
  fetchFn,
  workspaceConfigFn,
  runFn,
}: ExecuteJobConfig<TPrepared>): Promise<boolean> {
  let cloudJob: CloudJob | undefined = undefined;
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
  setWorkerRuntimeContext({ cloudJobId });

  try {
    const jobContext = await fetchFn(cloudJobId, workerReleaseMetadata);

    if (!jobContext) {
      startupLogger.debug.log('Failed to fetch job context');
      return false;
    }

    const { envVars } = jobContext;
    cloudJob = jobContext.cloudJob;
    const cloudJobIdForEvents = cloudJob.id;
    callbacks = callbackMap[cloudJob.type];

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
      cloudJobId: cloudJobIdForEvents,
      logger: startupLogger.debug,
    });
    backgroundEnvironmentSetupController =
      new BackgroundEnvironmentSetupController({
        cloudJob,
        recordWorkerRuntimeEvent,
      });

    // Snapshot user-specified DB env vars before injectEnvVars mutates the
    // object with system-level entries.
    const userEnvVars = { ...envVars };

    // Worker config values are read once here so their captured values
    // (auth keys, API URLs) can be reused throughout setup and runtime.
    const cloudTaskWorkspace = resolveCloudTaskWorkspace(cloudJob.payload);

    const environmentId =
      cloudTaskWorkspace.type === 'environment'
        ? cloudTaskWorkspace.environmentId
        : undefined;

    setWorkerRuntimeContext({
      cloudJobId: cloudJob.id,
      cloudJobType: cloudJob.type,
      environmentId,
      taskId: cloudJob.taskId,
    });

    const envVarKeys = Object.keys(envVars);

    startupLogger.debug.log(
      `[executeJob] Job context envVars: ${envVarKeys.length} keys${envVarKeys.length > 0 ? ` [${envVarKeys.join(', ')}]` : ''}`,
    );

    await injectEnvVars(envVars, cloudJob, {
      previewProxyBaseUrl: workerEnv.previewProxyBaseUrl,
      previewProxySubdomainSuffix: workerEnv.previewProxySubdomainSuffix,
      sourceControlToken: jobContext.sourceControlToken,
    });

    if (cloudJob.canceledAt) {
      await backgroundEnvironmentSetupController.flush();
      startupLogger.debug.log('Task is already canceled, exiting');
      await callbacks.onExit?.(cloudJob, CloudTaskStatus.Canceled, context);
      return true;
    }

    workerHeartbeatInterval = createWorkerHeartbeatInterval({
      cloudJobId: cloudJobIdForEvents,
      taskId: cloudJob.taskId,
      logger: {
        ...startupLogger.debug,
        warn: (message: string) => {
          startupLogger.debug.warn(message);
          void recordWorkerRuntimeEvent({
            eventType: 'failed',
            message: `Worker heartbeat update failed for cloud job #${cloudJobIdForEvents}.`,
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
      message: `Started worker heartbeat loop for cloud job #${cloudJobIdForEvents}.`,
      details: { heartbeatIntervalMs: WORKER_HEARTBEAT_INTERVAL_MS },
    });

    workerComputeUsageLoop = createComputeProviderUsageInterval({
      cloudJobId: cloudJobIdForEvents,
      computeProvider: resolveComputeProviderTarget(cloudJob.vendor),
      logger: {
        ...startupLogger.debug,
        warn: (message: string) => {
          startupLogger.debug.warn(message);

          void recordWorkerRuntimeEvent({
            eventType: 'failed',
            message: `Compute usage update failed for cloud job #${cloudJobIdForEvents}.`,
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
      message: `Started compute usage loop for cloud job #${cloudJobIdForEvents}.`,
      details: { computeUsageIntervalMs: WORKER_HEARTBEAT_INTERVAL_MS },
    });

    await sdk.cloudJobs.update({
      id: cloudJob.id,
      status: CloudTaskStatus.Preparing,
    });

    const workspace = await recordWorkerPhase({
      label: 'resolveWorkspaceConfig',
      recordWorkerRuntimeEvent,
      details: {
        cloudTaskType: cloudJob.type,
        setupMode,
      },
      fn: async () => await workspaceConfigFn(jobContext),
    });

    workerEnv.setRuntimeEnv(envVars);

    const serviceContext = buildServiceContextForPreviewProxy(
      cloudJob,
      workspace,
      workerEnv,
    );

    const runEnvironmentSetupInBackground =
      shouldRunParallelTaskEnvironmentSetup({
        cloudJob,
        jobContext,
        setupMode,
        workspace,
      });

    const currentCloudJob = cloudJob;
    const currentWorkerEnv = workerEnv;

    const {
      preparedWorkspace,
      backgroundOrganizationEnvironmentSetup:
        backgroundOrganizationEnvironmentSetupPromise,
    } = await recordWorkerPhase({
      label: 'setupWorkspace',
      recordWorkerRuntimeEvent,
      details: {
        cloudTaskType: cloudJob.type,
        setupMode,
        workspaceType: workspace.type,
        backgroundOrganizationEnvironmentSetup: runEnvironmentSetupInBackground,
      },
      fn: async () =>
        await setup({
          mode: setupMode,
          workspace: {
            workspace,
            envVars,
            userEnvVars,
            harness: currentCloudJob.harness,
            cloudJobType: currentCloudJob.type,
            preserveGitState,
            serviceContext,
            sourceControlProvider: resolveSourceControlProviderFromPayload(
              currentCloudJob.payload,
            ),
            gitAuthorName: jobContext.gitAuthor?.name,
            gitAuthorEmail: jobContext.gitAuthor?.email,
          },
          logger: startupLogger,
          workerEnv: currentWorkerEnv,
          backgroundOrganizationEnvironmentSetup:
            runEnvironmentSetupInBackground,
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
        cloudJob,
        backgroundSetupPromise: backgroundOrganizationEnvironmentSetupPromise,
        recordWorkerRuntimeEvent,
      });

    const workspacePath = preparedWorkspace?.workspacePath;

    const usesSharedWorkspaceRoot =
      preparedWorkspace?.usesSharedWorkspaceRoot ?? false;
    const repoPaths = preparedWorkspace?.repoPaths;
    const repoLocalSkills = preparedWorkspace?.repoLocalSkills;

    if (cloudJob && preparedWorkspace?.repositoryPreparationOutcome) {
      await recordWorkerRuntimeEvent(
        buildRepositoryPreparationEventInput({
          cloudJob,
          outcome: preparedWorkspace.repositoryPreparationOutcome,
        }),
      );
    }

    if (
      cloudJob &&
      preparedWorkspace?.environmentSetupWarnings &&
      preparedWorkspace.environmentSetupWarnings.length > 0
    ) {
      const warningMessages = preparedWorkspace.environmentSetupWarnings.map(
        (warning) => warning.message,
      );

      await recordWorkerRuntimeEvent({
        eventType: 'decision',
        message: `Continuing cloud job #${cloudJob.id} after environment setup warnings.`,
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
    await sdk.cloudJobs.stampMilestone({
      cloudJobId: cloudJob.id,
      field: 'setupCompletedAt',
    });

    writeBashrc(workerEnv.buildUserFacingEnv());

    if (cloudJob.canceledAt) {
      await backgroundEnvironmentSetupController.flush();
      startupLogger.debug.log('Task is already canceled, exiting');
      await callbacks.onExit?.(cloudJob, CloudTaskStatus.Canceled, context);
      return true;
    }

    harnessLogger = createHarnessLogger(cloudJob.id, {
      logToConsole: false,
    });

    await backgroundEnvironmentSetupController.preflightTaskStart();

    const runTaskPromise = runFn({
      jobContext,
      workspace,
      workspacePath,
      usesSharedWorkspaceRoot,
      repoPaths,
      repoLocalSkills,
      workspaceReadinessWarnings:
        preparedWorkspace?.environmentSetupWarnings?.map(
          (warning) => warning.message,
        ),
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
        cloudJob,
        logger: harnessLogger,
        callbacks,
        context,
      });
    } catch (error) {
      if (
        harnessLogger &&
        (await shouldSuppressFinalizeError({
          cloudJob,
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

    if (cloudJob && error instanceof WorkspaceRepositoryPreparationError) {
      const recordWorkerRuntimeEvent = createWorkerRuntimeEventRecorder({
        cloudJobId: cloudJob.id,
        logger: startupLogger.debug,
      });

      await recordWorkerRuntimeEvent(
        buildRepositoryPreparationEventInput({
          cloudJob,
          outcome: error.failure,
        }),
      );
    }

    const outcome = await handleJobError({
      error,
      cloudJob,
      logger: harnessLogger,
      callbacks,
      context,
    });

    return outcome !== 'failed';
  } finally {
    try {
      if (workerHeartbeatInterval) {
        clearInterval(workerHeartbeatInterval);

        if (cloudJob) {
          const recordWorkerRuntimeEvent = createWorkerRuntimeEventRecorder({
            cloudJobId: cloudJob.id,
            logger: startupLogger.debug,
          });

          await recordWorkerRuntimeEvent({
            eventType: 'completed',
            message: `Stopped worker heartbeat loop for cloud job #${cloudJob.id}.`,
            details: { reason: 'worker_heartbeat_loop_stopped' },
          });
        }
      }

      if (workerComputeUsageLoop) {
        workerComputeUsageLoop.stop();
        await workerComputeUsageLoop.flush({ updateKind: 'shutdown_flush' });

        if (cloudJob) {
          const recordWorkerRuntimeEvent = createWorkerRuntimeEventRecorder({
            cloudJobId: cloudJob.id,
            logger: startupLogger.debug,
          });

          await recordWorkerRuntimeEvent({
            eventType: 'completed',
            message: `Stopped compute usage loop for cloud job #${cloudJob.id}.`,
            details: { reason: 'compute_provider_usage_loop_stopped' },
          });
        }
      }
    } finally {
      clearWorkerRuntimeContext();
    }
  }
}
