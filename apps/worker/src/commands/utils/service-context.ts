import type { TaskRun } from '@roomote/sdk/client';
import {
  SHARED_DESKTOP_NAMED_PORT,
  assertNoReservedEnvironmentPorts,
  getPrimaryPortFromConfig,
} from '@roomote/types';

import type { WorkerEnv } from '../../env';
import type { ServiceContext } from '../../services';
import type { WorkspaceConfig } from '../../workspace';

interface WorkspacePortMappings {
  appPorts?: Record<string, number>;
  unauthenticatedPorts?: Set<string>;
  subdomains?: Record<string, string>;
  primaryPortName?: string | null;
  wildcardPrefixPorts?: Set<string>;
  authBypassPaths?: Record<string, string[]>;
}

export function buildWorkspacePortMappings(
  workspace: WorkspaceConfig,
): WorkspacePortMappings {
  if ('environmentConfig' in workspace) {
    assertNoReservedEnvironmentPorts(workspace.environmentConfig);
  }

  let appPorts: Record<string, number> | undefined;
  let unauthenticatedPorts: Set<string> | undefined;
  let subdomains: Record<string, string> | undefined;
  let primaryPortName: string | null | undefined;
  let wildcardPrefixPorts: Set<string> | undefined;
  let authBypassPaths: Record<string, string[]> | undefined;

  if ('environmentConfig' in workspace) {
    appPorts = {};
    const environmentPorts = workspace.environmentConfig.ports ?? [];

    if (environmentPorts.length > 0) {
      primaryPortName =
        getPrimaryPortFromConfig(environmentPorts)?.name ?? null;

      for (const port of environmentPorts) {
        const key = port.name.toUpperCase();
        appPorts[key] = port.port;

        if (port.unauthenticated === true) {
          if (!unauthenticatedPorts) {
            unauthenticatedPorts = new Set();
          }

          unauthenticatedPorts.add(key);
        }

        if (port.subdomain) {
          if (!subdomains) {
            subdomains = {};
          }

          subdomains[key] = port.subdomain;
        }

        if (port.wildcard_prefix === true) {
          if (!wildcardPrefixPorts) {
            wildcardPrefixPorts = new Set();
          }

          wildcardPrefixPorts.add(key);
        }

        if (port.auth_bypass_paths && port.auth_bypass_paths.length > 0) {
          if (!authBypassPaths) {
            authBypassPaths = {};
          }

          authBypassPaths[key] = port.auth_bypass_paths;
        }
      }
    }
  }

  return {
    appPorts,
    unauthenticatedPorts,
    subdomains,
    primaryPortName,
    wildcardPrefixPorts,
    authBypassPaths,
  };
}

function resolveAppOrigin(appUrl: string | undefined): string | undefined {
  if (!appUrl) {
    return undefined;
  }

  try {
    return new URL(appUrl).origin;
  } catch {
    return undefined;
  }
}

export function buildServiceContextForPreviewProxy(
  taskRun: TaskRun,
  workspace: WorkspaceConfig,
  workerEnv: WorkerEnv,
): ServiceContext | undefined {
  if (!workerEnv.previewAuthPublicKey) {
    return undefined;
  }

  const {
    appPorts: workspaceAppPorts,
    unauthenticatedPorts,
    subdomains,
    primaryPortName,
    wildcardPrefixPorts,
    authBypassPaths,
  } = buildWorkspacePortMappings(workspace);

  // The controller reserves the Roomote-managed Shared Desktop port for
  // environment-backed runs by adding it to the run's proxy ports. It never
  // appears in the environment config, so register its in-sandbox port here
  // or the multiplex proxy has nothing to route it to.
  const appPorts =
    workspaceAppPorts && taskRun.proxyPorts?.[SHARED_DESKTOP_NAMED_PORT.name]
      ? {
          ...workspaceAppPorts,
          [SHARED_DESKTOP_NAMED_PORT.name]: SHARED_DESKTOP_NAMED_PORT.port,
        }
      : workspaceAppPorts;

  const authBypassHeaderValue = taskRun.authBypassValue ?? undefined;

  const authBypassHeaderName = taskRun.authBypassHeaderName ?? undefined;

  return {
    runId: taskRun.id,
    taskId: taskRun.taskId,
    publicKey: workerEnv.previewAuthPublicKey,
    proxyPorts: taskRun.proxyPorts ?? undefined,
    appPorts,
    appOrigin: resolveAppOrigin(workerEnv.roomoteAppUrl),
    unauthenticatedPorts,
    subdomains,
    primaryPortName,
    wildcardPrefixPorts,
    authCookieName: workerEnv.previewAuthCookieName,
    authBypassPaths,
    authBypassHeaderValue,
    authBypassHeaderName,
  };
}
