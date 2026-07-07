import {
  CloudTaskStatus,
  environmentConfigSchema,
  type EnvironmentConfig,
  LEGACY_SANDBOX_GUI_NAMED_PORT_NAME,
  SANDBOX_SNAPSHOT_EXPIRY_MS,
  slugToPortKey,
} from '@roomote/types';
import {
  type CloudJob,
  cloudJobs,
  desc,
  environments,
  eq,
} from '@roomote/db/server';

import { db } from '../lib/db';
import { logger, escapeForLog } from '../lib/logger';

export type ResolverIdentifier = { taskId: string };

/**
 * Combined result from resolveRequest - includes both resolution status
 * and auth/context information needed for request handling.
 */
export interface ResolvedRequest {
  status:
    | 'active'
    | 'redirect'
    | 'redirect_to_direct'
    | 'gone'
    | 'not_found'
    | 'sandbox_unavailable'
    | 'resumable';
  sandboxUrl?: string;
  redirectUrl?: string;
  /**
   * Direct sandbox URL for unproxied ports.
   * Used with 'redirect_to_direct' status after auth validation.
   */
  directUrl?: string;
  cloudJob: CloudJob | null;
  requiresAuth: boolean;
  /**
   * Whether this specific port has an auth-proxy instance in front of it.
   * True for EDITOR port (always) or ports listed in cloudJob.proxyPorts.
   * When true, preview_auth cookie is forwarded for defense-in-depth validation.
   * When false, preview_auth cookie is stripped to prevent leakage to app backends.
   */
  hasAuthProxy: boolean;
  taskId?: string;
  error?: string;
  /**
   * Snapshot ID for auto-resume. Only present when status is 'resumable'.
   */
  snapshotId?: string;
  /**
   * When the snapshot was created. Used to check if snapshot is still valid.
   */
  snapshotCreatedAt?: Date;
  /**
   * Whether this port has wildcard_prefix enabled.
   * When true, the port accepts arbitrary prefixes in the subdomain
   * for nested preview-proxy routing.
   */
  wildcardPrefix?: boolean;
  /**
   * Path prefixes that bypass authentication for this port.
   * Populated from the environment config's `auth_bypass_paths` per-port setting.
   */
  authBypassPaths?: string[];
  /**
   * Value for the auth bypass header. When a request includes
   * the bypass header with this value, auth is skipped.
   * Populated from `cloudJob.authBypassValue`.
   */
  authBypassHeaderValue?: string;
  /**
   * Custom header name for the auth bypass mechanism.
   * Defaults to `x-bypass-roomote-auth` when not set.
   * Populated from `cloudJob.authBypassHeaderName`.
   */
  authBypassHeaderName?: string;
  requestedPortKey?: string;
}

/**
 * Check if a snapshot is still valid (within the 7-day expiry window).
 */
function isSnapshotValid(snapshotCreatedAt: Date | null): boolean {
  if (!snapshotCreatedAt) {
    return false;
  }

  return Date.now() - snapshotCreatedAt.getTime() < SANDBOX_SNAPSHOT_EXPIRY_MS;
}

function resolveRuntimeEnvironmentConfig(
  config: unknown,
): EnvironmentConfig | undefined {
  if (!config) {
    return undefined;
  }

  const runtimeConfig = environmentConfigSchema.safeParse(config);

  if (runtimeConfig.success) {
    return runtimeConfig.data;
  }

  logger.warn(
    { issues: runtimeConfig.error.issues },
    'Failed to parse environment config for preview proxy resolution',
  );
  return undefined;
}

/**
 * Resolves a request completely in a single call - combining sandbox URL resolution
 * with auth context resolution to minimize DB queries.
 *
 * Resolution logic:
 * 1. Active job - Returns sandbox URL with auth requirements
 * 2. Completed job with taskId - Redirects to task ID URL (stable URL across resumes)
 * 3. Completed job without taskId - Finds most recent resumed job, redirects there
 * 4. Nothing found - Returns 'gone' status
 */
export async function resolveRequest(
  identifier: ResolverIdentifier,
  portName: string,
): Promise<ResolvedRequest> {
  const requestedPortKey = slugToPortKey(portName);

  if (requestedPortKey === LEGACY_SANDBOX_GUI_NAMED_PORT_NAME) {
    return {
      status: 'not_found',
      cloudJob: null,
      requiresAuth: true,
      hasAuthProxy: false,
      requestedPortKey,
      error: `Port "${portName}" is no longer available through preview-proxy.`,
    };
  }

  try {
    const cloudJob = await db.query.cloudJobs.findFirst({
      where: eq(cloudJobs.taskId, identifier.taskId),
      orderBy: desc(cloudJobs.createdAt),
    });

    const identifierLog = { taskId: escapeForLog(identifier.taskId) };

    if (!cloudJob) {
      logger.info(identifierLog, 'Job not found');

      return {
        status: 'not_found',
        cloudJob: null,
        requiresAuth: true,
        hasAuthProxy: false,
        requestedPortKey,
      };
    }

    const taskId = cloudJob.taskId ?? undefined;

    // Check port configuration for auth requirements and proxied status
    const portConfig = await checkPortConfig(cloudJob, portName);

    // Handle unproxied ports: require auth, then redirect to direct sandbox URL
    if (!portConfig.isProxied) {
      // Only redirect if sandbox is active
      if (
        cloudJob.status === CloudTaskStatus.Running ||
        cloudJob.status === CloudTaskStatus.Idle
      ) {
        const directUrl = getSandboxUrl(cloudJob, portName);

        if (!directUrl) {
          logger.info(
            {
              ...identifierLog,
              portName: escapeForLog(portName),
            },
            'Unproxied port not found in machineDomains',
          );

          return {
            status: 'not_found',
            error: `Port "${portName}" not found for job`,
            cloudJob,
            taskId,
            requiresAuth: true,
            hasAuthProxy: false,
          };
        }

        logger.info(
          {
            ...identifierLog,
            portName: escapeForLog(portName),
            directUrl: escapeForLog(directUrl),
          },
          'Unproxied port: will redirect to direct URL after auth',
        );

        return {
          status: 'redirect_to_direct',
          directUrl,
          cloudJob,
          taskId,
          requiresAuth: portConfig.requiresAuth,
          hasAuthProxy: false,
          wildcardPrefix: portConfig.wildcardPrefix,
          requestedPortKey,
        };
      }

      // Sandbox not active - return not_found with helpful message
      logger.info(
        {
          ...identifierLog,
          portName: escapeForLog(portName),
          status: cloudJob.status,
        },
        'Unproxied port requested but sandbox not active',
      );

      return {
        status: 'not_found',
        error: `Port "${portName}" is not available through preview-proxy.`,
        cloudJob,
        taskId,
        requiresAuth: true,
        hasAuthProxy: false,
        requestedPortKey,
      };
    }

    // If job is active, return the sandbox URL with auth context
    if (
      cloudJob.status === CloudTaskStatus.Running ||
      cloudJob.status === CloudTaskStatus.Idle
    ) {
      const sandboxUrl = getSandboxUrl(cloudJob, portName);

      if (!sandboxUrl) {
        logger.info(
          {
            ...identifierLog,
            portName: escapeForLog(portName),
            availablePorts: cloudJob.machineDomains
              ? Object.keys(cloudJob.machineDomains)
              : [],
          },
          'Port not found for job',
        );

        return {
          status: 'not_found',
          error: `Port "${portName}" not found for job`,
          cloudJob,
          taskId,
          requiresAuth: true,
          hasAuthProxy: false,
        };
      }

      // Determine if this specific port has an auth-proxy instance.
      // Per-port membership check: EDITOR always has auth-proxy, and
      // any port explicitly listed in proxyPorts has one.
      const portKey = slugToPortKey(portName);
      const proxyPorts = cloudJob.proxyPorts as Record<string, unknown> | null;
      const hasAuthProxy =
        portKey === 'EDITOR' || (proxyPorts != null && portKey in proxyPorts);

      return {
        status: 'active',
        sandboxUrl,
        cloudJob,
        taskId,
        requiresAuth: portConfig.requiresAuth,
        hasAuthProxy,
        wildcardPrefix: portConfig.wildcardPrefix,
        authBypassPaths: portConfig.authBypassPaths,
        authBypassHeaderValue: cloudJob.authBypassValue ?? undefined,
        authBypassHeaderName: cloudJob.authBypassHeaderName ?? undefined,
        requestedPortKey,
      };
    }

    // Job is completed/canceled - handle redirect logic
    if (
      cloudJob.status === CloudTaskStatus.Completed ||
      cloudJob.status === CloudTaskStatus.Canceled
    ) {
      logger.info(
        { ...identifierLog, status: cloudJob.status },
        'Job completed or canceled',
      );

      // taskId persists across job resumes, so no redirect is needed.

      // No active job found - check if this job can be auto-resumed
      const canAutoResume =
        cloudJob.snapshotId != null &&
        isSnapshotValid(cloudJob.snapshotCreatedAt);

      if (canAutoResume) {
        logger.info(
          {
            ...identifierLog,
            snapshotId: cloudJob.snapshotId,
            snapshotCreatedAt: cloudJob.snapshotCreatedAt,
          },
          'Job is resumable from snapshot',
        );

        return {
          status: 'resumable',
          cloudJob,
          taskId,
          snapshotId: cloudJob.snapshotId!,
          snapshotCreatedAt: cloudJob.snapshotCreatedAt!,
          requiresAuth: true,
          hasAuthProxy: false,
          requestedPortKey,
        };
      }

      // No snapshot available - job is gone
      return {
        status: 'gone',
        cloudJob,
        taskId,
        requiresAuth: true,
        hasAuthProxy: false,
        requestedPortKey,
      };
    }

    // Job is in a non-active state (queued, processing, etc.)
    logger.info(
      { ...identifierLog, status: cloudJob.status },
      'Sandbox unavailable',
    );

    return {
      status: 'sandbox_unavailable',
      cloudJob,
      taskId,
      requiresAuth: true,
      hasAuthProxy: false,
      requestedPortKey,
    };
  } catch (err) {
    logger.error(
      { error: err, taskId: escapeForLog(identifier.taskId) },
      'Error resolving sandbox URL',
    );

    return {
      status: 'not_found',
      error: 'Internal error resolving sandbox',
      cloudJob: null,
      requiresAuth: true,
      hasAuthProxy: false,
      requestedPortKey,
    };
  }
}

/**
 * Result of checking port authentication requirements.
 */
interface PortAuthResult {
  requiresAuth: boolean;
  isProxied: boolean;
  wildcardPrefix: boolean;
  authBypassPaths?: string[];
}

function uniqueNonEmptyPaths(paths: Array<string | undefined>): string[] {
  return [...new Set(paths.filter((path): path is string => Boolean(path)))];
}

/**
 * Check if a port requires authentication for a cloud job.
 * Also returns whether the port is proxied (for cookie forwarding decision).
 */
async function checkPortConfig(
  cloudJob: CloudJob,
  portName: string,
): Promise<PortAuthResult> {
  const portKey = slugToPortKey(portName);

  if (portKey === 'EDITOR') {
    return { requiresAuth: true, isProxied: true, wildcardPrefix: false };
  }

  if (portKey === 'SANDBOX_SERVER') {
    return { requiresAuth: false, isProxied: true, wildcardPrefix: false };
  }

  const environmentId = (cloudJob.payload as { environmentId?: string } | null)
    ?.environmentId;

  if (!environmentId) {
    return { requiresAuth: true, isProxied: true, wildcardPrefix: false };
  }

  const environment = await db.query.environments.findFirst({
    where: eq(environments.id, environmentId),
  });
  const environmentConfig = resolveRuntimeEnvironmentConfig(
    environment?.config,
  );

  const portConfig = environmentConfig?.ports?.find(
    (port) => port.name.toUpperCase() === portKey,
  );

  if (!portConfig) {
    return {
      requiresAuth: true,
      isProxied: true,
      wildcardPrefix: false,
    };
  }

  const authBypassPaths = uniqueNonEmptyPaths([
    ...(portConfig.auth_bypass_paths ?? []),
  ]);

  return {
    requiresAuth: portConfig.unauthenticated !== true,
    isProxied: portConfig.proxied !== false,
    wildcardPrefix: portConfig.wildcard_prefix === true,
    authBypassPaths: authBypassPaths.length > 0 ? authBypassPaths : undefined,
  };
}

/**
 * Extracts the sandbox URL for a specific port from the cloud job.
 */
function getSandboxUrl(
  cloudJob: {
    machineDomains: Record<string, string> | null;
    machineDomain?: string | null;
  },
  portName: string,
): string | null {
  // Convert URL slug back to port key for lookup
  // URL slugs are lowercase with hyphens; storage keys are uppercase with underscores
  const portKey = slugToPortKey(portName);

  if (cloudJob.machineDomains && typeof cloudJob.machineDomains === 'object') {
    const url = cloudJob.machineDomains[portKey];
    if (url) return url;
  }

  if (portName === 'default' && cloudJob.machineDomain) {
    return cloudJob.machineDomain;
  }

  return null;
}
