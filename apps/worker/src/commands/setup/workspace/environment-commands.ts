import type { EnvironmentWorkspace } from '../../../workspace';
import { ExecutionError } from '../../../command-executor';
import type { StartupLogger } from '../../../logging';
import type { PhaseRecorder } from '../logging';
import type { EnvironmentSetupWarning, PrepareWorkspaceResult } from './types';
import type { EnvironmentSetupStatusWriter } from './setup-status';
import { createWorkspaceManager } from './shared';

interface SetupOrganizationEnvironmentOptions {
  environment: EnvironmentWorkspace;
  envVars: Record<string, string | undefined>;
  userEnvVars?: Record<string, string>;
  preparedWorkspace?: PrepareWorkspaceResult;
  continueRepositoryCommandFailures?: boolean;
  /** Mirrors per-command progress to `<workspace>/.roomote/setup-status.json`. */
  setupStatusWriter?: EnvironmentSetupStatusWriter;
  /** Records one durable task-run phase event per repository command. */
  recordPhase?: PhaseRecorder;
}

function getEnvironmentRepoPaths(
  preparedWorkspace?: PrepareWorkspaceResult,
): Record<string, string> | undefined {
  return preparedWorkspace?.environment?.repoPaths;
}

export async function installOrganizationEnvironmentSkills(
  logger: StartupLogger,
  {
    environment,
    envVars,
    preparedWorkspace,
  }: SetupOrganizationEnvironmentOptions,
): Promise<void> {
  const repoPaths = getEnvironmentRepoPaths(preparedWorkspace);

  if (!repoPaths) {
    return;
  }

  const { workspaceManager } = createWorkspaceManager(envVars);

  logger.userLog.log('Setting up your environment');

  if (
    environment.environmentConfig.skills &&
    Object.keys(environment.environmentConfig.skills).length > 0
  ) {
    await workspaceManager.installEnvironmentSkills(
      environment.environmentConfig.skills,
    );
  }

  if (
    environment.environmentConfig.manualSkills &&
    environment.environmentConfig.manualSkills.length > 0
  ) {
    await workspaceManager.installManualEnvironmentSkills(
      environment.environmentConfig.manualSkills,
    );
  }
}

export async function executeOrganizationEnvironmentRepositoryCommands(
  logger: StartupLogger,
  {
    environment,
    envVars,
    userEnvVars,
    preparedWorkspace,
    continueRepositoryCommandFailures:
      _continueRepositoryCommandFailures = false,
    setupStatusWriter,
    recordPhase,
  }: SetupOrganizationEnvironmentOptions,
): Promise<EnvironmentSetupWarning[]> {
  const repoPaths = getEnvironmentRepoPaths(preparedWorkspace);
  const warnings: EnvironmentSetupWarning[] = [];

  if (!repoPaths) {
    return warnings;
  }

  const { workspaceManager } = createWorkspaceManager(envVars);

  try {
    await workspaceManager.executeEnvironmentRepositoryCommands(
      environment.environmentConfig.repositories,
      repoPaths,
      userEnvVars,
      {
        continueOnError: true,
        onCommandStart: ({ repository, commandName }) => {
          setupStatusWriter?.markCommandRunning(repository, commandName);
        },
        onCommandResult: ({ repository, result }) => {
          setupStatusWriter?.markCommandResult(repository, result);

          if (recordPhase) {
            const endedAtMs = Date.now();

            // Best-effort durable audit trail; must not affect setup outcome.
            void Promise.resolve(
              recordPhase({
                label: `environmentRepositoryCommand: ${repository} ${result.command.name}`,
                startedAtMs: endedAtMs - result.duration,
                endedAtMs,
                durationMs: result.duration,
                outcome: result.success ? 'ok' : 'error',
              }),
            ).catch(() => {});
          }
        },
        onCommandFailure: ({ repository, result }) => {
          const warningMessage = `Optional environment command "${result.command.name}" failed for ${repository}: ${
            result.error ?? 'Command failed.'
          }`;
          const warning: EnvironmentSetupWarning = {
            message: warningMessage,
          };
          warnings.push(warning);

          logger.userLog.warn(
            `${warningMessage} Continuing without a fully configured environment.`,
          );
          logger.debug.warn(
            `[${repository}] Environment command "${result.command.name}" failed during environment setup:\n${new ExecutionError(
              result.error ?? 'Unknown execution error',
              result,
            ).formatDetails()}`,
          );
        },
      },
    );
  } catch (error) {
    setupStatusWriter?.finalize({
      warnings: warnings.map((warning) => warning.message),
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  setupStatusWriter?.finalize({
    warnings: warnings.map((warning) => warning.message),
  });

  return warnings;
}

export async function setupOrganizationEnvironment(
  logger: StartupLogger,
  options: SetupOrganizationEnvironmentOptions,
): Promise<EnvironmentSetupWarning[]> {
  await installOrganizationEnvironmentSkills(logger, options);

  return executeOrganizationEnvironmentRepositoryCommands(logger, options);
}
