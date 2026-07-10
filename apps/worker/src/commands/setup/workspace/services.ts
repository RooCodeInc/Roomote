import {
  type EnvironmentConfig,
  type ServiceInfo,
  TaskPayloadKind,
  isServicesEnabledCloudTaskType,
} from '@roomote/types';

import type { StartupLogger } from '../../../logging';
import {
  type ServiceContext,
  ServiceManager,
  startPortProxies,
} from '../../../services';

import { timedStep } from '../logging';

import type { PrepareWorkspaceOptions } from './types';
import {
  applyEnvironmentEnvVars,
  resolveRuntimePathsForWorker,
} from './shared';

interface InitializeWorkspaceServicesResult {
  services: ServiceInfo[];
  env: Record<string, string>;
}

export async function initializeAllServices(
  logger: StartupLogger,
  { workspace, envVars, cloudJobType, serviceContext }: PrepareWorkspaceOptions,
): Promise<InitializeWorkspaceServicesResult> {
  const systemServices = await initializeSystemServices(logger, {
    workspace,
    envVars,
    cloudJobType,
    serviceContext,
  });

  const environmentServices = await initializeEnvironmentServices(logger, {
    workspace,
    envVars,
    cloudJobType,
    serviceContext,
  });

  return {
    services: [...systemServices.services, ...environmentServices.services],
    env: { ...envVars } as Record<string, string>,
  };
}

export async function initializeSystemServices(
  logger: StartupLogger,
  { workspace, envVars, cloudJobType }: PrepareWorkspaceOptions,
): Promise<InitializeWorkspaceServicesResult> {
  const workspaceRoot = resolveRuntimePathsForWorker().workspaceReposDir;

  applyEnvironmentEnvVars(workspace, envVars);

  const environmentConfig =
    workspace.type === 'environment' ? workspace.environmentConfig : undefined;

  const services = await startSystemServices({
    workspaceRoot,
    envVars,
    cloudJobType,
    environmentConfig,
    logger,
  });

  return { services, env: { ...envVars } as Record<string, string> };
}

export async function initializeEnvironmentServices(
  logger: StartupLogger,
  { workspace, envVars, serviceContext }: PrepareWorkspaceOptions,
): Promise<InitializeWorkspaceServicesResult> {
  const workspaceRoot = resolveRuntimePathsForWorker().workspaceReposDir;

  applyEnvironmentEnvVars(workspace, envVars);

  const environmentConfig =
    workspace.type === 'environment' ? workspace.environmentConfig : undefined;

  const services = await startEnvironmentServices({
    workspaceRoot,
    envVars,
    serviceContext,
    environmentConfig,
    logger,
  });

  return { services, env: { ...envVars } as Record<string, string> };
}

async function startSystemServices({
  workspaceRoot,
  envVars,
  cloudJobType,
  environmentConfig,
  logger,
}: {
  workspaceRoot: string;
  envVars: Record<string, string | undefined>;
  cloudJobType: TaskPayloadKind;
  environmentConfig?: EnvironmentConfig;
  logger: StartupLogger;
}): Promise<ServiceInfo[]> {
  const services: ServiceInfo[] = [];

  if (
    environmentConfig &&
    isServicesEnabledCloudTaskType(cloudJobType) &&
    environmentConfig.services &&
    environmentConfig.services.length > 0
  ) {
    const manager = new ServiceManager(workspaceRoot, envVars);

    const started = await manager.startServices(
      logger,
      environmentConfig.services,
    );

    services.push(...started);
  }

  return services;
}

async function startEnvironmentServices({
  workspaceRoot: _workspaceRoot,
  envVars: _envVars,
  serviceContext,
  environmentConfig: _environmentConfig,
  logger,
}: {
  workspaceRoot: string;
  envVars: Record<string, string | undefined>;
  serviceContext?: ServiceContext;
  environmentConfig?: EnvironmentConfig;
  logger: StartupLogger;
}): Promise<ServiceInfo[]> {
  const services: ServiceInfo[] = [];

  // Start port proxies if proxyPorts are configured.
  // These proxies forward from the externally exposed proxy port to the internal app port.
  // They also validate JWT tokens for users who access sandbox URLs directly.
  if (
    serviceContext?.proxyPorts &&
    serviceContext.appPorts &&
    serviceContext.publicKey
  ) {
    logger.userLog.log('Starting port proxies...');

    try {
      const args = {
        proxyPorts: serviceContext.proxyPorts,
        appPorts: serviceContext.appPorts,
        taskId: serviceContext.taskId || 'unknown',
        publicKey: serviceContext.publicKey,
        unauthenticatedPorts: serviceContext.unauthenticatedPorts,
        subdomains: serviceContext.subdomains,
        wildcardPrefixPorts: serviceContext.wildcardPrefixPorts,
        authCookieName: serviceContext.authCookieName,
        authBypassPaths: serviceContext.authBypassPaths,
        authBypassHeaderValue: serviceContext.authBypassHeaderValue,
        authBypassHeaderName: serviceContext.authBypassHeaderName,
      };

      await timedStep(logger, 'start port proxies', () =>
        startPortProxies(args),
      );

      logger.userLog.log(
        `Started ${Object.keys(args.proxyPorts).length} port proxies`,
      );
    } catch (error) {
      logger.userLog.error(
        `Failed to start port proxies: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return services;
}
