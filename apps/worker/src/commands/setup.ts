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

import { CloudTaskType } from '@roomote/types';

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
  initializeAllServices,
  installOrganizationEnvironmentSkills,
  executeOrganizationEnvironmentRepositoryCommands,
  setupOrganizationEnvironment,
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
  backgroundOrganizationEnvironmentSetup?: boolean;
}

interface SetupResult {
  preparedWorkspace?: PrepareWorkspaceResult;
  workerEnv: WorkerEnv;
  backgroundOrganizationEnvironmentSetup?: Promise<EnvironmentSetupWarning[]>;
}

interface RunSetupResult {
  preparedWorkspace?: PrepareWorkspaceResult;
  backgroundOrganizationEnvironmentSetup?: Promise<EnvironmentSetupWarning[]>;
}

function shouldContinueEnvironmentSetupFailures({
  cloudJobType,
}: {
  cloudJobType: CloudTaskType;
}): boolean {
  return cloudJobType !== CloudTaskType.SnapshotEnvironment;
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
  return 'Environment setup is still running in the background. Repository setup commands may still be installing dependencies or preparing services.';
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
  backgroundOrganizationEnvironmentSetup = false,
}: SetupOptions): Promise<SetupResult> {
  const setupStartedAt = Date.now();
  const harness = resolveWorkerCodingHarness(workspaceOpts.harness);

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
      workspaceOpts.cloudJobType === CloudTaskType.SnapshotEnvironment,
    envVars: {
      ...workerEnv.buildUserFacingEnv(),
      ...workspaceOpts.envVars,
    },
  };
  let result: PrepareWorkspaceResult | undefined;
  let backgroundOrganizationEnvironmentSetupPromise:
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
      backgroundOrganizationEnvironmentSetup,
    });
    result = setupResult.preparedWorkspace;
    backgroundOrganizationEnvironmentSetupPromise =
      setupResult.backgroundOrganizationEnvironmentSetup;
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
    backgroundOrganizationEnvironmentSetup:
      backgroundOrganizationEnvironmentSetupPromise,
  };
}

async function runSetup({
  logger,
  workspaceOptions,
  initializeServicesFn,
  recordPhase,
  backgroundOrganizationEnvironmentSetup = false,
}: SetupExecutionContext & {
  backgroundOrganizationEnvironmentSetup?: boolean;
}): Promise<RunSetupResult> {
  const environmentSetupWarnings: EnvironmentSetupWarning[] = [];
  const continueEnvironmentSetupFailures =
    workspaceOptions.workspace.type === 'environment' &&
    shouldContinueEnvironmentSetupFailures({
      cloudJobType: workspaceOptions.cloudJobType,
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

  await timedStep(
    logger,
    'installPython',
    () => installPython(logger),
    recordPhase,
  );

  let backgroundOrganizationEnvironmentSetupPromise:
    | Promise<EnvironmentSetupWarning[]>
    | undefined;

  await timedStep(
    logger,
    'setupOrganizationEnvironment',
    async () => {
      const workspace = workspaceOptions.workspace;

      if (!initializeRepositoriesResult || workspace.type !== 'environment') {
        return;
      }

      if (!backgroundOrganizationEnvironmentSetup) {
        const warnings =
          (await setupOrganizationEnvironment(logger, {
            environment: workspace,
            envVars: workspaceOptions.envVars,
            userEnvVars: workspaceOptions.userEnvVars,
            preparedWorkspace: initializeRepositoriesResult,
            continueRepositoryCommandFailures: continueEnvironmentSetupFailures,
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

      const backgroundWarning = buildBackgroundEnvironmentSetupWarning();
      environmentSetupWarnings.push({ message: backgroundWarning });
      logger.userLog.log(
        'Continuing task startup while environment repository commands finish in the background',
      );

      backgroundOrganizationEnvironmentSetupPromise = timedStep(
        logger,
        'setupOrganizationEnvironmentCommands (background)',
        async () => {
          try {
            const warnings =
              await executeOrganizationEnvironmentRepositoryCommands(logger, {
                environment: workspace,
                envVars: workspaceOptions.envVars,
                userEnvVars: workspaceOptions.userEnvVars,
                preparedWorkspace: initializeRepositoriesResult,
                continueRepositoryCommandFailures: true,
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
      );
    },
    recordPhase,
  );

  if (initializeRepositoriesResult && environmentSetupWarnings.length > 0) {
    initializeRepositoriesResult.environmentSetupWarnings =
      environmentSetupWarnings;
  }

  return {
    preparedWorkspace: initializeRepositoriesResult,
    backgroundOrganizationEnvironmentSetup:
      backgroundOrganizationEnvironmentSetupPromise,
  };
}
