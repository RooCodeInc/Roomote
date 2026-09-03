/**
 * Worker setup module.
 *
 * This module handles environment setup, VSCode configuration, and extension
 * installation. It runs at the start of each task and is idempotent - safe to
 * run multiple times as it checks for existing state before making changes.
 *
 * Worker release archive extraction is handled separately by the provider
 * machine helpers (via .docker/sandbox/install-worker.sh) since worker.js
 * needs to exist before this can run.
 */

import {
  buildInferenceGatewayOpenCodeBaseUrl,
  buildInferenceGatewayUrl,
  CONTROL_PLANE_ENV_VAR_NAMES,
  getInferenceGatewayProvider,
  SANDBOX_OPENROUTER_GATEWAY_BASE_URL_ENV_VAR_NAME,
  SANDBOX_OPENROUTER_GATEWAY_PROVIDER_ID,
  TaskPayloadKind,
} from '@roomote/types';

import { ExecutionError } from '../command-executor';
import type { WorkerEnv } from '../env';
import { resolveWorkerCodingHarness } from '../lib/resolve-worker-coding-harness';
import type { StartupLogger } from '../logging';

import {
  type EnvironmentSetupWarning,
  type PhaseRecorder,
  type PrepareWorkspaceOptions,
  type PrepareWorkspaceResult,
  formatDurationMs,
  timedStep,
  setupSystem,
  installMise,
  installAgentClis,
  installNodePty,
  installEmojiFont,
  installAgentBrowser,
  installBubblewrap,
  installMediaBinaries,
  ensurePython3,
  installPython,
  initializeRepositories,
  initializeDockerProjects,
  initializeAllServices,
  installOrganizationEnvironmentSkills,
  executeOrganizationEnvironmentRepositoryCommands,
  setupOrganizationEnvironment,
  EnvironmentSetupStatusWriter,
} from './setup/index';

export type SetupMode = 'full' | 'directDispatch';

interface SetupExecutionContext {
  logger: StartupLogger;
  workspaceOptions: PrepareWorkspaceOptions;
  initializeServicesFn: (
    logger: StartupLogger,
    workspaceOptions: PrepareWorkspaceOptions,
  ) => Promise<unknown>;
  recordPhase?: PhaseRecorder;
}

interface SetupOptions {
  workspace: PrepareWorkspaceOptions;
  mode: SetupMode;
  logger: StartupLogger;
  workerEnv: WorkerEnv;
  recordPhase?: PhaseRecorder;
  backgroundEnvironmentSetup?: boolean;
}

interface SetupResult {
  preparedWorkspace?: PrepareWorkspaceResult;
  workerEnv: WorkerEnv;
  backgroundEnvironmentSetup?: Promise<EnvironmentSetupWarning[]>;
}

interface RunSetupResult {
  preparedWorkspace?: PrepareWorkspaceResult;
  backgroundEnvironmentSetup?: Promise<EnvironmentSetupWarning[]>;
}

function shouldContinueEnvironmentSetupFailures({
  taskRunType,
}: {
  taskRunType: TaskPayloadKind;
}): boolean {
  return taskRunType !== TaskPayloadKind.SnapshotEnvironment;
}

function formatEnvironmentSetupErrorDetails(error: unknown): string {
  if (error instanceof ExecutionError) {
    return error.formatDetails();
  }

  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  return String(error);
}

function buildEnvironmentServicesWarning(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  return `Environment services failed to start: ${message}`;
}

function buildBackgroundEnvironmentSetupWarning(): string {
  return 'Environment setup is still running in the background. Docker projects may still be building or waiting for health checks, and repository setup commands may still be installing dependencies or preparing services.';
}

/**
 * Runs the complete worker setup.
 * This is idempotent and safe to call multiple times.
 */
export async function setup({
  workspace: workspaceOpts,
  mode,
  logger,
  workerEnv,
  recordPhase,
  backgroundEnvironmentSetup = false,
}: SetupOptions): Promise<SetupResult> {
  const setupStartedAt = Date.now();
  const harness = resolveWorkerCodingHarness(workspaceOpts.harness);
  const sandboxOpenRouterProvider = getInferenceGatewayProvider(
    SANDBOX_OPENROUTER_GATEWAY_PROVIDER_ID,
  );

  if (!sandboxOpenRouterProvider) {
    throw new Error('Sandbox OpenRouter gateway provider is not registered');
  }
  const workspaceRuntimeEnvVars = Object.fromEntries(
    Object.entries(workspaceOpts.envVars).filter(
      ([name]) => !CONTROL_PLANE_ENV_VAR_NAMES.has(name),
    ),
  );

  logger.userLog.log(`Setup started (harness: ${harness}, mode: ${mode})`);

  await timedStep(
    logger,
    'setupSystem',
    () => setupSystem(logger),
    recordPhase,
  );

  // setupSystem modifies process.env (PATH, LC_ALL, etc.).
  // Worker config values (auth keys, API URLs) are NOT re-read.
  workerEnv.refreshSystemEnv(process.env);

  const workspaceOptions = {
    ...workspaceOpts,
    cleanupLegacyPaths:
      workspaceOpts.taskRunType === TaskPayloadKind.SnapshotEnvironment,
    envVars: {
      ...workerEnv.buildUserFacingEnv(),
      ...workspaceRuntimeEnvVars,
      ...(workspaceOpts.workspace.type === 'environment' && {
        // Environment setup may start a nested Roomote deployment. Give it
        // only the existing run-scoped gateway credentials, never provider
        // keys held by the parent control plane.
        ROOMOTE_PLATFORM_API_URL: workerEnv.trpcUrl,
        ROOMOTE_CLOUD_TOKEN: workerEnv.authToken,
        [SANDBOX_OPENROUTER_GATEWAY_BASE_URL_ENV_VAR_NAME]:
          buildInferenceGatewayOpenCodeBaseUrl(
            buildInferenceGatewayUrl(workerEnv.trpcUrl),
            sandboxOpenRouterProvider,
          ),
      }),
    },
  };
  let result: PrepareWorkspaceResult | undefined;
  let backgroundEnvironmentSetupPromise:
    | Promise<EnvironmentSetupWarning[]>
    | undefined;

  if (mode === 'directDispatch') {
    logger.userLog.log(
      'Direct dispatch setup enabled: reusing the current sandbox and only preparing repositories',
    );

    await timedStep(
      logger,
      'initializeRepositories',
      async () => {
        result = await initializeRepositories(logger, workspaceOptions);
      },
      recordPhase,
    );
  } else {
    const setupResult = await runSetup({
      logger,
      workspaceOptions,
      initializeServicesFn: initializeAllServices,
      recordPhase,
      backgroundEnvironmentSetup,
    });
    result = setupResult.preparedWorkspace;
    backgroundEnvironmentSetupPromise = setupResult.backgroundEnvironmentSetup;
  }

  logger.userLog.log(
    `Setup completed in ${formatDurationMs(Date.now() - setupStartedAt)}`,
  );

  if (workspaceOptions) {
    const runtimeEnv = workerEnv.getRuntimeEnv();
    const workspaceEnv = Object.fromEntries(
      Object.entries(workspaceOptions.envVars).filter(([key, value]) => {
        if (value === undefined) {
          return false;
        }

        return !(key in runtimeEnv) || runtimeEnv[key] !== value;
      }),
    );

    workerEnv.setUserEnv(workspaceEnv);
  }

  return {
    preparedWorkspace: result,
    workerEnv,
    backgroundEnvironmentSetup: backgroundEnvironmentSetupPromise,
  };
}

async function runSetup({
  logger,
  workspaceOptions,
  initializeServicesFn,
  recordPhase,
  backgroundEnvironmentSetup = false,
}: SetupExecutionContext & {
  backgroundEnvironmentSetup?: boolean;
}): Promise<RunSetupResult> {
  const environmentSetupWarnings: EnvironmentSetupWarning[] = [];
  const continueEnvironmentSetupFailures =
    workspaceOptions.workspace.type === 'environment' &&
    shouldContinueEnvironmentSetupFailures({
      taskRunType: workspaceOptions.taskRunType,
    });

  await timedStep(
    logger,
    'setup (serial)',
    async () => {
      await timedStep(
        logger,
        'installBubblewrap',
        () => installBubblewrap(logger),
        recordPhase,
      );

      await timedStep(
        logger,
        'ensurePython3',
        () => ensurePython3(logger),
        recordPhase,
      );

      await timedStep(
        logger,
        'installAgentBrowser',
        () => installAgentBrowser(logger),
        recordPhase,
      );

      await timedStep(
        logger,
        'installMediaBinaries',
        () => installMediaBinaries(logger),
        recordPhase,
      );

      await timedStep(
        logger,
        'installMise',
        () => installMise(logger),
        recordPhase,
      );

      await timedStep(
        logger,
        'installAgentClis',
        () => installAgentClis(logger),
        recordPhase,
      );

      await timedStep(
        logger,
        'installNodePty',
        () => installNodePty(logger),
        recordPhase,
      );
    },
    recordPhase,
  );

  let initializeRepositoriesResult: PrepareWorkspaceResult | undefined;
  const backgroundSetupTasks: Array<Promise<EnvironmentSetupWarning[]>> = [];
  let backgroundDockerProjectsTask:
    | Promise<EnvironmentSetupWarning[]>
    | undefined;

  const systemSetup: Promise<void>[] = [
    timedStep(
      logger,
      'installEmojiFont',
      () => installEmojiFont(logger),
      recordPhase,
    ),
    timedStep(
      logger,
      'initializeRepositories',
      async () => {
        initializeRepositoriesResult = await initializeRepositories(
          logger,
          workspaceOptions,
        );
      },
      recordPhase,
    ),
    timedStep(
      logger,
      'initializeServices',
      async () => {
        try {
          await initializeServicesFn(logger, workspaceOptions);
        } catch (error) {
          if (!continueEnvironmentSetupFailures) {
            throw error;
          }

          const warning = buildEnvironmentServicesWarning(error);
          environmentSetupWarnings.push({ message: warning });
          logger.userLog.warn(
            `${warning} Continuing without a fully configured environment.`,
          );
          logger.debug.warn(
            `Environment service setup failed but task startup will continue:\n${formatEnvironmentSetupErrorDetails(
              error,
            )}`,
          );
        }
      },
      recordPhase,
    ),
  ];

  await timedStep(
    logger,
    'setup (parallel)',
    () => Promise.all(systemSetup),
    recordPhase,
  );

  if (initializeRepositoriesResult) {
    const initializeDockerProjectsTask = async (): Promise<
      EnvironmentSetupWarning[]
    > => {
      try {
        await initializeDockerProjects(
          logger,
          workspaceOptions,
          initializeRepositoriesResult!,
        );
        return [];
      } catch (error) {
        if (!backgroundEnvironmentSetup) {
          throw error;
        }

        const warning = `Background Docker project setup failed: ${
          error instanceof Error ? error.message : String(error)
        }`;
        const warningDetails = { message: warning };
        environmentSetupWarnings.push(warningDetails);
        logger.userLog.warn(
          `${warning} Continuing without a fully configured environment.`,
        );
        logger.debug.warn(
          `Background Docker project setup failed:\n${formatEnvironmentSetupErrorDetails(
            error,
          )}`,
        );
        return [warningDetails];
      }
    };

    const dockerProjectsStep = () =>
      timedStep(
        logger,
        backgroundEnvironmentSetup
          ? 'initializeDockerProjects (background)'
          : 'initializeDockerProjects',
        initializeDockerProjectsTask,
        recordPhase,
      );

    if (backgroundEnvironmentSetup) {
      backgroundDockerProjectsTask = dockerProjectsStep();
      backgroundSetupTasks.push(backgroundDockerProjectsTask);
    } else {
      await dockerProjectsStep();
    }
  }

  await timedStep(
    logger,
    'installPython',
    () => installPython(logger),
    recordPhase,
  );

  await timedStep(
    logger,
    'setupOrganizationEnvironment',
    async () => {
      const workspace = workspaceOptions.workspace;

      if (!initializeRepositoriesResult || workspace.type !== 'environment') {
        return;
      }

      // Publish the command plan to <workspace>/.roomote/setup-status.json
      // before the agent can start, so the sandbox always has an observable
      // answer to "has environment setup finished?". Created for every
      // environment workspace — including Docker-only or command-less
      // setups — because the sandbox instruction and the settle notification
      // point the agent at this file and must be able to rely on it existing.
      const setupStatusWriter = new EnvironmentSetupStatusWriter(
        initializeRepositoriesResult.workspacePath,
      );
      setupStatusWriter.initialize(
        workspace.environmentConfig.repositories,
        initializeRepositoriesResult.environment?.repoPaths,
      );

      if (!backgroundEnvironmentSetup) {
        const warnings =
          (await setupOrganizationEnvironment(logger, {
            environment: workspace,
            envVars: workspaceOptions.envVars,
            userEnvVars: workspaceOptions.userEnvVars,
            preparedWorkspace: initializeRepositoriesResult,
            continueRepositoryCommandFailures: continueEnvironmentSetupFailures,
            setupStatusWriter,
            recordPhase,
          })) ?? [];

        environmentSetupWarnings.push(...warnings);

        return;
      }

      await installOrganizationEnvironmentSkills(logger, {
        environment: workspace,
        envVars: workspaceOptions.envVars,
        userEnvVars: workspaceOptions.userEnvVars,
        preparedWorkspace: initializeRepositoriesResult,
      });

      backgroundSetupTasks.push(
        timedStep(
          logger,
          'setupOrganizationEnvironmentCommands (background)',
          async () => {
            try {
              const dockerProjectWarnings =
                (await backgroundDockerProjectsTask) ?? [];

              // Reflect Docker project failures in the workspace status file
              // so it never reports a clean `completed` when part of
              // environment setup went wrong.
              if (dockerProjectWarnings.length > 0) {
                setupStatusWriter?.addWarnings(
                  dockerProjectWarnings.map((warning) => warning.message),
                );
              }

              const warnings =
                await executeOrganizationEnvironmentRepositoryCommands(logger, {
                  environment: workspace,
                  envVars: workspaceOptions.envVars,
                  userEnvVars: workspaceOptions.userEnvVars,
                  preparedWorkspace: initializeRepositoriesResult,
                  continueRepositoryCommandFailures: true,
                  setupStatusWriter,
                  recordPhase,
                });

              environmentSetupWarnings.push(...warnings);
              return warnings;
            } catch (error) {
              const warning = `Background environment setup failed unexpectedly: ${
                error instanceof Error ? error.message : String(error)
              }`;
              const warningDetails = { message: warning };
              environmentSetupWarnings.push(warningDetails);
              logger.userLog.warn(
                `${warning} Continuing without a fully configured environment.`,
              );
              logger.debug.warn(
                `Background environment setup failed unexpectedly:\n${formatEnvironmentSetupErrorDetails(
                  error,
                )}`,
              );
              return [warningDetails];
            }
          },
          recordPhase,
        ),
      );
    },
    recordPhase,
  );

  let backgroundEnvironmentSetupPromise:
    | Promise<EnvironmentSetupWarning[]>
    | undefined;

  if (backgroundSetupTasks.length > 0) {
    const backgroundWarning = buildBackgroundEnvironmentSetupWarning();
    environmentSetupWarnings.push({ message: backgroundWarning });
    logger.userLog.log(
      'Continuing task startup while Docker projects and environment repository commands finish in the background',
    );
    backgroundEnvironmentSetupPromise = Promise.all(backgroundSetupTasks).then(
      (warnings) => warnings.flat(),
    );
  }

  if (initializeRepositoriesResult && environmentSetupWarnings.length > 0) {
    initializeRepositoriesResult.environmentSetupWarnings =
      environmentSetupWarnings;
  }

  return {
    preparedWorkspace: initializeRepositoriesResult,
    backgroundEnvironmentSetup: backgroundEnvironmentSetupPromise,
  };
}
