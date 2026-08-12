import {
  type ComputeProviderLaunchMode,
  type NamedPort,
  serializeError,
} from '@roomote/types';

import { generateProxyPorts, getExposedPorts } from '../environment-machine';
import { createComputeProviderClient } from '../factory';
import { throwIfAborted } from '../modal/abort';
import { loadSandboxBootstrapFiles } from '../sandbox/bootstrap-files';
import { getWorkerRelease } from '../sandbox/worker-release-cache';
import { loadLocalWorkerReleaseWithVersion } from '../sandbox/utils';
import type {
  BoxConfig,
  ComputeProviderClient,
  ComputeProviderMutationObserver,
} from '../types';

const REMOTE_BOOTSTRAP_DIR = '/tmp/roomote-bootstrap';
const INSTALL_SCRIPT_PATH = `${REMOTE_BOOTSTRAP_DIR}/install-worker.sh`;
const WORKER_TARBALL_PATH = `${REMOTE_BOOTSTRAP_DIR}/worker.tar.gz`;

type BoxLifecycleClient = Pick<
  ComputeProviderClient,
  | 'vendor'
  | 'createInstance'
  | 'resumeFromStandby'
  | 'writeFiles'
  | 'runCommand'
  | 'getInstanceDomains'
  | 'destroyInstance'
  | 'enterStandby'
>;

export interface CreateBoxMachineOptions {
  boxApiKey: string;
  boxApiBaseUrl?: string;
  timeoutMs?: number;
  machineType?: 'small' | 'default' | 'large';
  idempotencyKey?: string;
  namedPorts?: NamedPort[];
  proxyPorts?: Record<string, number>;
  localTarballPath?: string;
  signal?: AbortSignal;
  bootstrapTimeoutMs?: number;
  computeClient?: BoxLifecycleClient;
  onMutation?: ComputeProviderMutationObserver;
}

export interface BoxMachine {
  machineId: string;
  proxyPorts: Record<string, number>;
  sourceSnapshotId?: string;
  domain: (port: number) => string;
}

export type BoxLaunchOptions =
  | { launchMode: 'fresh'; resumeHandle?: undefined }
  | { launchMode: 'task_standby'; resumeHandle: string };

export type CreateBoxMachineParams = CreateBoxMachineOptions & BoxLaunchOptions;

export async function createBoxMachine(
  options: CreateBoxMachineParams,
): Promise<BoxMachine> {
  throwIfAborted(options.signal);
  const proxyPorts =
    options.proxyPorts ?? generateProxyPorts(options.namedPorts);
  const ports = getExposedPorts(options.namedPorts, proxyPorts);
  const release =
    options.launchMode === 'fresh'
      ? options.localTarballPath
        ? loadLocalWorkerReleaseWithVersion(options.localTarballPath)
        : await getWorkerRelease()
      : undefined;

  const config: BoxConfig = {
    apiKey: options.boxApiKey,
    ...(options.boxApiBaseUrl ? { boxApiBaseUrl: options.boxApiBaseUrl } : {}),
    ...(options.timeoutMs !== undefined
      ? { timeoutMs: options.timeoutMs }
      : {}),
    ...(options.machineType ? { machineType: options.machineType } : {}),
  };
  const computeClient =
    options.computeClient ??
    createComputeProviderClient({ provider: 'box', config });
  if (computeClient.vendor !== 'box') {
    throw new Error('createBoxMachine requires a Box compute client');
  }

  const operation = options.resumeHandle
    ? 'resume_from_standby'
    : 'create_instance';
  await options.onMutation?.({
    provider: 'box',
    operation,
    eventType: 'started',
    message: options.resumeHandle
      ? `Calling resumeFromStandby for Box ${options.resumeHandle}.`
      : 'Calling createInstance for Box.',
    details: {
      launchMode: options.launchMode as ComputeProviderLaunchMode,
      sourceSnapshotId: options.resumeHandle ?? null,
      ports,
    },
  });

  let created: { instanceId: string };
  try {
    if (options.resumeHandle) {
      if (!computeClient.resumeFromStandby) {
        throw new Error('Box compute client does not support standby resume');
      }
      created = await computeClient.resumeFromStandby({
        resumeHandle: options.resumeHandle,
        signal: options.signal,
      });
    } else {
      created = await computeClient.createInstance({
        idempotencyKey: options.idempotencyKey,
        metadata: release
          ? { workerReleaseTag: `worker-v${release.version}` }
          : undefined,
        signal: options.signal,
      });
    }
    await options.onMutation?.({
      provider: 'box',
      operation,
      eventType: 'completed',
      instanceId: created.instanceId,
      message: `${options.resumeHandle ? 'resumeFromStandby' : 'createInstance'} completed for Box ${created.instanceId}.`,
      details: {
        launchMode: options.launchMode as ComputeProviderLaunchMode,
        sourceSnapshotId: options.resumeHandle ?? null,
        ports,
      },
    });
  } catch (error) {
    await options.onMutation?.({
      provider: 'box',
      operation,
      eventType: 'failed',
      message: `${options.resumeHandle ? 'resumeFromStandby' : 'createInstance'} failed for Box.`,
      details: {
        launchMode: options.launchMode as ComputeProviderLaunchMode,
        sourceSnapshotId: options.resumeHandle ?? null,
        ports,
        error: serializeError(error).message,
      },
    });
    throw error;
  }

  if (release) {
    const bootstrapTimeoutSignal = options.bootstrapTimeoutMs
      ? AbortSignal.timeout(options.bootstrapTimeoutMs)
      : undefined;
    const bootstrapSignal =
      bootstrapTimeoutSignal && options.signal
        ? AbortSignal.any([bootstrapTimeoutSignal, options.signal])
        : (bootstrapTimeoutSignal ?? options.signal);
    try {
      const { files } = loadSandboxBootstrapFiles(REMOTE_BOOTSTRAP_DIR);
      files.push({ path: WORKER_TARBALL_PATH, content: release.archive });
      await computeClient.writeFiles({
        instanceId: created.instanceId,
        files,
        signal: bootstrapSignal,
      });
      const install = await computeClient.runCommand({
        instanceId: created.instanceId,
        cmd: 'bash',
        args: [INSTALL_SCRIPT_PATH],
        env: {
          HOME: '/home/user',
          WORKER_RELEASE_ARCHIVE_PATH: WORKER_TARBALL_PATH,
        },
        signal: bootstrapSignal,
      });
      if (install.exitCode !== 0) {
        throw new Error(
          `Box worker install failed with exit code ${install.exitCode}: ${install.stderr ?? install.stdout ?? 'no output'}`,
        );
      }
    } catch (error) {
      await computeClient
        .destroyInstance({ instanceId: created.instanceId })
        .catch(() => {});
      throw error;
    }
  }

  let domains: Record<string, string> | undefined;
  try {
    domains = ports.length
      ? (
          await computeClient.getInstanceDomains?.({
            instanceId: created.instanceId,
            ports,
            signal: options.signal,
          })
        )?.domains
      : {};
    if (ports.length && !domains) {
      throw new Error('Box compute client does not support private port URLs');
    }
  } catch (error) {
    const cleanup = options.resumeHandle
      ? computeClient.enterStandby?.({ instanceId: created.instanceId })
      : computeClient.destroyInstance({ instanceId: created.instanceId });
    await cleanup?.catch(() => {});
    throw error;
  }

  return {
    machineId: created.instanceId,
    proxyPorts,
    ...(options.resumeHandle ? { sourceSnapshotId: options.resumeHandle } : {}),
    domain: (port) => {
      const domain = domains?.[String(port)];
      if (!domain) {
        throw new Error(
          `Box ${created.instanceId} has no private URL for port ${port}`,
        );
      }
      return domain;
    },
  };
}
