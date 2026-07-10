import { Env } from '@roomote/env';
import {
  type ComputeProvider,
  type ComputeProviderConfiguredResources,
  type EnvironmentConfig,
  type NamedPort,
  resolveComputeProviderTarget,
} from '@roomote/types';
import {
  areDeploymentPreviewsEnabled,
  normalizeMetadataRecord,
} from '@roomote/feature-flags';
import {
  type CloudJob,
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

interface DeploymentRuntimeFlags {
  livePreviewsEnabled: boolean;
}

type ShouldEnableAuthBypassForCloudJobParams = {
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

function configuredPreviewPortNeedsAuthBypass(port: NamedPort): boolean {
  return requiresPreviewAuth(port) && port.proxied !== false;
}

async function resolveDeploymentRuntimeFlags(): Promise<DeploymentRuntimeFlags> {
  const settings = await db.query.deploymentSettings.findFirst({
    columns: {
      metadata: true,
    },
  });

  const metadata = normalizeMetadataRecord(settings?.metadata);
  const previewRuntimeConfig = await resolveEffectivePreviewRuntimeConfig({
    runtimeEnv: process.env,
    defaultPreviewProxyBaseUrl: Env.PREVIEW_PROXY_BASE_URL,
    defaultPreviewDomains: Env.PREVIEW_DOMAINS,
  });

  return {
    livePreviewsEnabled:
      areDeploymentPreviewsEnabled(metadata) &&
      previewRuntimeConfig.analysis.isReady,
  };
}

export function shouldEnableAuthBypassForCloudJob({
  environmentConfig,
  namedPorts,
}: ShouldEnableAuthBypassForCloudJobParams): boolean {
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

    if (configuredPreviewPortNeedsAuthBypass(configuredPort)) {
      return true;
    }
  }

  return false;
}

/**
 * Builds the Roomote-managed surface list for a cloud job.
 * Always includes SANDBOX_SERVER for environment-backed jobs.
 * Also returns `environmentSnapshotId` when the environment has a valid,
 * non-expired snapshot.
 */
export async function getNamedPortsForCloudJob(
  cloudJob: CloudJob,
): Promise<NamedPortsResult> {
  let namedPorts = getNamedPortsForEnvironment({});
  let environmentSnapshotId: string | undefined;
  let environmentConfig: EnvironmentConfig | undefined;

  if (cloudJob.payload.environmentId) {
    const environment = await db.query.environments.findFirst({
      where: eq(environments.id, cloudJob.payload.environmentId),
    });

    if (environment) {
      environmentConfig = environment.config;
      const deploymentRuntimeFlags = await resolveDeploymentRuntimeFlags();

      namedPorts = getNamedPortsForEnvironment({
        ports:
          deploymentRuntimeFlags.livePreviewsEnabled &&
          environmentConfig.previews_enabled !== false
            ? environmentConfig.ports
            : undefined,
      });

      // Check if environment has a ready snapshot we can use.
      const provider = resolveComputeProviderTarget(cloudJob.vendor);
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

type UpdateCloudJobMachineInfoParams = {
  cloudJob: CloudJob;
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

type UpdateCloudJobMachineOptions = {
  db?: DatabaseOrTransaction;
};

/**
 * Updates the cloud job record with machine ID, domain information, proxy
 * ports, and source snapshot.
 *
 * Accepts either a pre-built `machineDomains` map, or `namedPorts` + `domainFn`
 * to compute it.
 */
export async function updateCloudJobMachine(
  params: UpdateCloudJobMachineInfoParams,
  options: UpdateCloudJobMachineOptions = {},
): Promise<void> {
  const {
    cloudJob,
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
          sourceSnapshotId && !cloudJob.sourceSnapshotId
          ? { sourceSnapshotId }
          : {}),
      ...(authBypassValue ? { authBypassValue } : {}),
      ...(authBypassHeaderName ? { authBypassHeaderName } : {}),
      ...(configuredVcpus !== undefined ? { configuredVcpus } : {}),
      ...(configuredCpuCores !== undefined ? { configuredCpuCores } : {}),
      ...(configuredMemoryMiB !== undefined ? { configuredMemoryMiB } : {}),
    })
    .where(eq(taskRuns.id, cloudJob.id));
}
