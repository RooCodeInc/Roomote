import { Env } from '@roomote/env';
import {
  type ComputeProvider,
  type ComputeProviderConfiguredResources,
  type EnvironmentConfig,
  type NamedPort,
  resolveComputeProviderTarget,
} from '@roomote/types';
import {
  type TaskRun,
  type DatabaseOrTransaction,
  db,
  taskRuns,
  environments,
  eq,
  getEnvironmentSnapshot,
  resolveEffectivePreviewRuntimeConfig,
} from '@roomote/db/server';
import {
  buildMachineRoutingInfo,
  getNamedPortsForEnvironment,
} from '@roomote/compute-providers';

interface NamedPortsResult {
  namedPorts: NamedPort[];
  /** Snapshot ID from the environment (if ready and not expired). */
  environmentSnapshotId?: string;
  /** The environment config, if an environment was found. */
  environmentConfig?: EnvironmentConfig;
}

type ShouldEnableAuthBypassForTaskRunParams = {
  environmentConfig?: EnvironmentConfig;
  namedPorts: NamedPort[];
};

function normalizePortName(name: string): string {
  return name.toUpperCase();
}

function requiresPreviewAuth(
  port: Pick<NamedPort, 'unauthenticated'>,
): boolean {
  return port.unauthenticated !== true;
}

async function isPreviewRuntimeReady(): Promise<boolean> {
  const previewRuntimeConfig = await resolveEffectivePreviewRuntimeConfig({
    runtimeEnv: process.env,
    defaultPreviewProxyBaseUrl: Env.PREVIEW_PROXY_BASE_URL,
    defaultPreviewDomains: Env.PREVIEW_DOMAINS,
  });

  return previewRuntimeConfig.analysis.isReady;
}

export function shouldEnableAuthBypassForTaskRun({
  environmentConfig,
  namedPorts,
}: ShouldEnableAuthBypassForTaskRunParams): boolean {
  if (!environmentConfig || environmentConfig.auth_bypass_header === false) {
    return false;
  }

  const exposedPortsByName = new Map(
    namedPorts.map((port) => [normalizePortName(port.name), port] as const),
  );

  for (const configuredPort of environmentConfig.ports ?? []) {
    if (!exposedPortsByName.has(normalizePortName(configuredPort.name))) {
      continue;
    }

    // Unproxied ports still enter through the authenticated preview URL before
    // the preview proxy redirects to the direct machine domain. Agents need a
    // task-scoped bypass credential for that entrypoint too.
    if (requiresPreviewAuth(configuredPort)) {
      return true;
    }
  }

  return false;
}

/**
 * Builds the Roomote-managed surface list for a task run.
 * Always includes SANDBOX_SERVER for environment-backed task runs.
 * Also returns `environmentSnapshotId` when the environment has a valid,
 * non-expired snapshot.
 */
export async function getNamedPortsForTaskRun(
  taskRun: TaskRun,
): Promise<NamedPortsResult> {
  let namedPorts = getNamedPortsForEnvironment({});
  let environmentSnapshotId: string | undefined;
  let environmentConfig: EnvironmentConfig | undefined;

  if (taskRun.payload.environmentId) {
    const environment = await db.query.environments.findFirst({
      where: eq(environments.id, taskRun.payload.environmentId),
    });

    if (environment) {
      environmentConfig = environment.config;
      const previewRuntimeReady = await isPreviewRuntimeReady();

      namedPorts = getNamedPortsForEnvironment({
        ports: previewRuntimeReady ? environmentConfig.ports : undefined,
      });

      // Check if environment has a ready snapshot we can use.
      const provider = resolveComputeProviderTarget(taskRun.vendor);
      const snapshot = await getEnvironmentSnapshot({
        environmentId: environment.id,
        provider,
      });

      if (
        snapshot?.snapshotId &&
        snapshot.snapshotStatus === 'ready' &&
        snapshot.snapshotExpiresAt &&
        snapshot.snapshotExpiresAt > new Date()
      ) {
        environmentSnapshotId = snapshot.snapshotId;
      }

      return {
        namedPorts,
        environmentSnapshotId,
        environmentConfig,
      };
    }
  }

  return { namedPorts, environmentSnapshotId, environmentConfig };
}

type UpdateTaskRunMachineInfoParams = {
  taskRun: TaskRun;
  vendor?: ComputeProvider;
  machineId: string;
  proxyPorts?: Record<string, number>;
  sourceSnapshotId?: string | null;
  explicitPrimaryPortName?: string;
  sandboxServerUrl?: string;
  authBypassValue?: string;
  authBypassHeaderName?: string;
} & Partial<ComputeProviderConfiguredResources> &
  (
    | {
        /** Pre-built domain map from provider-specific routing info. */
        machineDomains: Record<string, string>;
        namedPorts?: never;
        domainFn?: never;
      }
    | {
        /** Build machineDomains from namedPorts + a domain resolver. */
        namedPorts: NamedPort[];
        domainFn: (port: number) => string;
        machineDomains?: never;
      }
  );

type UpdateTaskRunMachineOptions = {
  db?: DatabaseOrTransaction;
};

/**
 * Updates the task run record with machine ID, domain information, proxy
 * ports, and source snapshot.
 *
 * Accepts either a pre-built `machineDomains` map, or `namedPorts` + `domainFn`
 * to compute it.
 */
export async function updateTaskRunMachine(
  params: UpdateTaskRunMachineInfoParams,
  options: UpdateTaskRunMachineOptions = {},
): Promise<void> {
  const {
    taskRun,
    vendor,
    machineId,
    proxyPorts,
    sourceSnapshotId,
    explicitPrimaryPortName,
    sandboxServerUrl,
    authBypassValue,
    authBypassHeaderName,
    configuredVcpus,
    configuredCpuCores,
    configuredMemoryMiB,
  } = params;

  const routingInfo =
    'namedPorts' in params && params.namedPorts
      ? buildMachineRoutingInfo({
          namedPorts: params.namedPorts,
          domainFn: params.domainFn,
          proxyPorts,
          explicitPrimaryPortName,
        })
      : buildMachineRoutingInfo({
          machineDomains: params.machineDomains,
          proxyPorts,
          explicitPrimaryPortName,
        });

  const database = options.db ?? db;

  await database
    .update(taskRuns)
    .set({
      ...(vendor ? { vendor } : {}),
      machineId,
      machineDomain: routingInfo.machineDomain,
      machineDomains: routingInfo.machineDomains,
      primaryPortName: routingInfo.primaryPortName,
      sandboxServerUrl: sandboxServerUrl ?? routingInfo.sandboxServerUrl,
      proxyPorts:
        proxyPorts && Object.keys(proxyPorts).length > 0
          ? proxyPorts
          : undefined,
      ...(sourceSnapshotId === null
        ? { sourceSnapshotId: null }
        : // Only set sourceSnapshotId if not already set (preserve explicit resume source).
          sourceSnapshotId && !taskRun.sourceSnapshotId
          ? { sourceSnapshotId }
          : {}),
      ...(authBypassValue ? { authBypassValue } : {}),
      ...(authBypassHeaderName ? { authBypassHeaderName } : {}),
      ...(configuredVcpus !== undefined ? { configuredVcpus } : {}),
      ...(configuredCpuCores !== undefined ? { configuredCpuCores } : {}),
      ...(configuredMemoryMiB !== undefined ? { configuredMemoryMiB } : {}),
    })
    .where(eq(taskRuns.id, taskRun.id));
}

/**
 * Clears persisted routing / machine fields after an aborted or failed spawn
 * removed the underlying sandbox. Terminal finalization does not clear these.
 */
export async function clearTaskRunMachine(
  taskRunId: number,
  options: UpdateTaskRunMachineOptions = {},
): Promise<void> {
  const database = options.db ?? db;

  await database
    .update(taskRuns)
    .set({
      machineId: null,
      machineDomain: null,
      machineDomains: null,
      primaryPortName: null,
      sandboxServerUrl: null,
      sandboxCmdId: null,
      proxyPorts: null,
    })
    .where(eq(taskRuns.id, taskRunId));
}
