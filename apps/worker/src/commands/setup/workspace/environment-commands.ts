import type { EnvironmentWorkspace } from '../../../workspace';
import { ExecutionError } from '../../../command-executor';
import type { StartupLogger } from '../../../logging';
import type { EnvironmentSetupWarning, PrepareWorkspaceResult } from './types';
import { createWorkspaceManager } from './shared';

interface SetupOrganizationEnvironmentOptions {
  environment: EnvironmentWorkspace;
  envVars: Record<string, string | undefined>;
  userEnvVars?: Record<string, string>;
  preparedWorkspace?: PrepareWorkspaceResult;
  continueRepositoryCommandFailures?: boolean;
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
  }: SetupOrganizationEnvironmentOptions,
): Promise<EnvironmentSetupWarning[]> {
  const repoPaths = getEnvironmentRepoPaths(preparedWorkspace);
  const warnings: EnvironmentSetupWarning[] = [];

  if (!repoPaths) {
    return warnings;
  }

  const { workspaceManager } = createWorkspaceManager(envVars);

  await workspaceManager.executeEnvironmentRepositoryCommands(
    environment.environmentConfig.repositories,
    repoPaths,
    userEnvVars,
    {
      continueOnError: true,
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

  return warnings;
}

export async function setupOrganizationEnvironment(
  logger: StartupLogger,
  options: SetupOrganizationEnvironmentOptions,
): Promise<EnvironmentSetupWarning[]> {
  await installOrganizationEnvironmentSkills(logger, options);

  return executeOrganizationEnvironmentRepositoryCommands(logger, options);
}
