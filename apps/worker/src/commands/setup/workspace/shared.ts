import * as fs from 'node:fs';

import { isComputeProvider, resolveWorkerRuntimePaths } from '@roomote/types';

import { substituteEnvVars } from '../../../env';
import type { StartupLogger } from '../../../logging';
import { WorkspaceManager, type WorkspaceConfig } from '../../../workspace';

import { timedStep } from '../logging';

export function resolveRuntimePathsForWorker() {
  const providerFromEnv =
    process.env.COMPUTE_PROVIDER ?? process.env.WORKER_TARGET;

  if (providerFromEnv && isComputeProvider(providerFromEnv)) {
    return resolveWorkerRuntimePaths({ provider: providerFromEnv });
  }

  return resolveWorkerRuntimePaths({ existsSync: fs.existsSync });
}

export function createWorkspaceManager(
  envVars: Record<string, string | undefined>,
  logger?: StartupLogger,
): {
  workspaceRoot: string;
  workspaceManager: WorkspaceManager;
} {
  const workspaceRoot = resolveRuntimePathsForWorker().workspaceReposDir;
  const workspaceManager = new WorkspaceManager(
    workspaceRoot,
    envVars,
    // If you want to expose verbose logging on development, use:
    // process.env.APP_ENV === 'development',
    false,
    logger
      ? (label, fn) => timedStep(logger, `initializeRepositories: ${label}`, fn)
      : undefined,
  );

  return { workspaceRoot, workspaceManager };
}

export function applyEnvironmentEnvVars(
  workspace: WorkspaceConfig,
  envVars: Record<string, string | undefined>,
): void {
  if (workspace.type === 'environment' && workspace.environmentConfig.env) {
    Object.assign(
      envVars,
      substituteEnvVars(
        workspace.environmentConfig.env,
        getDefinedEnvVars(envVars),
      ),
    );
  }

  if (
    workspace.type === 'environment' &&
    workspace.environmentConfig.oidc?.aws
  ) {
    envVars.AWS_WEB_IDENTITY_TOKEN_FILE =
      workspace.environmentConfig.oidc.aws.token_file;
    envVars.AWS_ROLE_ARN = workspace.environmentConfig.oidc.aws.role_arn;

    if (workspace.environmentConfig.oidc.aws.region) {
      envVars.AWS_REGION = workspace.environmentConfig.oidc.aws.region;
      envVars.AWS_DEFAULT_REGION = workspace.environmentConfig.oidc.aws.region;
    }
  }
}

function getDefinedEnvVars(
  envVars: Record<string, string | undefined>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(envVars).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}
