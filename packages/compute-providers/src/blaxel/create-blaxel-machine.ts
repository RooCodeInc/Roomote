import {
  type ComputeProviderLaunchMode,
  type NamedPort,
  SANDBOX_FILES_DIR,
  serializeError,
} from '@roomote/types';

import { generateProxyPorts, getExposedPorts } from '../environment-machine';
import { createComputeProviderClient } from '../factory';
import { isAbortError, sleepWithSignal, throwIfAborted } from '../modal/abort';
import { loadSandboxBootstrapFiles } from '../sandbox/bootstrap-files';
import { getWorkerRelease } from '../sandbox/worker-release-cache';
import { loadLocalWorkerReleaseWithVersion } from '../sandbox/utils';
import type {
  ComputeProviderClient,
  ComputeProviderMutationObserver,
} from '../types';

const MAX_RETRIES = 3;
const INSTALL_SCRIPT_PATH = `${SANDBOX_FILES_DIR}/install-worker.sh`;
const WORKER_TARBALL_PATH = `${SANDBOX_FILES_DIR}/worker.tar.gz`;

type BlaxelLifecycleClient = Pick<
  ComputeProviderClient,
  | 'vendor'
  | 'createInstance'
  | 'resumeFromStandby'
  | 'writeFiles'
  | 'runCommand'
  | 'destroyInstance'
>;

export interface CreateBlaxelMachineOptions {
  blaxelApiKey: string;
  blaxelWorkspace: string;
  blaxelImage: string;
  blaxelRegion?: string;
  namedPorts?: NamedPort[];
  proxyPorts?: Record<string, number>;
  timeoutMs?: number;
  localTarballPath?: string;
  tags?: Record<string, string>;
  signal?: AbortSignal;
  createInstanceTimeoutMs?: number;
  bootstrapTimeoutMs?: number;
  computeClient?: BlaxelLifecycleClient;
  onMutation?: ComputeProviderMutationObserver;
}

export interface BlaxelMachine {
  machineId: string;
  proxyPorts: Record<string, number>;
  sourceSnapshotId?: string;
  domain: (port: number) => string;
}

export type BlaxelLaunchOptions =
  | { launchMode: 'fresh'; resumeHandle?: undefined }
  | { launchMode: 'task_standby'; resumeHandle: string };

export type CreateBlaxelMachineParams = CreateBlaxelMachineOptions &
  BlaxelLaunchOptions;

export async function createBlaxelMachine(
  options: CreateBlaxelMachineParams,
): Promise<BlaxelMachine> {
  const proxyPorts =
    options.proxyPorts ?? generateProxyPorts(options.namedPorts);
  const ports = getExposedPorts(options.namedPorts, proxyPorts);
  const createSignal = options.createInstanceTimeoutMs
    ? AbortSignal.timeout(options.createInstanceTimeoutMs)
    : options.signal;
  throwIfAborted(createSignal);

  const release =
    options.launchMode === 'fresh'
      ? options.localTarballPath
        ? loadLocalWorkerReleaseWithVersion(options.localTarballPath)
        : await getWorkerRelease()
      : undefined;
  const computeClient =
    options.computeClient ??
    createComputeProviderClient({
      provider: 'blaxel',
      config: {
        apiKey: options.blaxelApiKey,
        workspace: options.blaxelWorkspace,
        image: options.blaxelImage,
        region: options.blaxelRegion,
        timeoutMs: options.timeoutMs,
      },
    });
  if (computeClient.vendor !== 'blaxel') {
    throw new Error('createBlaxelMachine requires a Blaxel compute client');
  }

  let created:
    | { instanceId: string; domains?: Record<string, string> }
    | undefined;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const operation = options.resumeHandle
        ? 'resume_from_standby'
        : 'create_instance';
      await options.onMutation?.({
        provider: 'blaxel',
        operation,
        eventType: 'started',
        message: options.resumeHandle
          ? `Calling resumeFromStandby for Blaxel sandbox ${options.resumeHandle}.`
          : 'Calling createInstance for Blaxel sandbox.',
        details: {
          attempt,
          launchMode: options.launchMode as ComputeProviderLaunchMode,
          sourceSnapshotId: options.resumeHandle ?? null,
          ports,
        },
      });
      if (options.resumeHandle) {
        if (!computeClient.resumeFromStandby) {
          throw new Error(
            'Blaxel compute client does not support standby resume',
          );
        }
        created = await computeClient.resumeFromStandby({
          resumeHandle: options.resumeHandle,
          ports,
          tags: options.tags,
          signal: createSignal,
        });
      } else {
        created = await computeClient.createInstance({
          ports,
          tags: options.tags,
          metadata: {
            ...(release
              ? { workerReleaseTag: `worker-v${release.version}` }
              : {}),
            ...(options.timeoutMs
              ? { timeoutMs: String(options.timeoutMs) }
              : {}),
          },
          signal: createSignal,
        });
      }
      await options.onMutation?.({
        provider: 'blaxel',
        operation,
        eventType: 'completed',
        instanceId: created.instanceId,
        message: `${
          options.resumeHandle ? 'resumeFromStandby' : 'createInstance'
        } completed for Blaxel sandbox ${created.instanceId}.`,
        details: {
          attempt,
          launchMode: options.launchMode as ComputeProviderLaunchMode,
          sourceSnapshotId: options.resumeHandle ?? null,
          ports,
        },
      });
      break;
    } catch (error) {
      const errorMessage = serializeError(error).message;
      await options.onMutation?.({
        provider: 'blaxel',
        operation: options.resumeHandle
          ? 'resume_from_standby'
          : 'create_instance',
        eventType: 'failed',
        message: `${
          options.resumeHandle ? 'resumeFromStandby' : 'createInstance'
        } failed for Blaxel sandbox.`,
        details: {
          attempt,
          launchMode: options.launchMode as ComputeProviderLaunchMode,
          sourceSnapshotId: options.resumeHandle ?? null,
          ports,
          error: errorMessage,
        },
      });
      if (isAbortError(error)) throw error;
      if (attempt === MAX_RETRIES) {
        throw error instanceof Error ? error : new Error(errorMessage);
      }
      await sleepWithSignal(2_000 * 2 ** (attempt - 1), createSignal);
    }
  }
  if (!created) throw new Error('Failed to create Blaxel sandbox');

  if (release) {
    const bootstrapSignal = options.bootstrapTimeoutMs
      ? AbortSignal.timeout(options.bootstrapTimeoutMs)
      : options.signal;
    try {
      const { files } = loadSandboxBootstrapFiles(SANDBOX_FILES_DIR);
      files.push({ path: WORKER_TARBALL_PATH, content: release.archive });
      await options.onMutation?.({
        provider: 'blaxel',
        operation: 'write_files',
        eventType: 'started',
        instanceId: created.instanceId,
        message: `Calling writeFiles for Blaxel sandbox ${created.instanceId}.`,
        details: {
          launchMode: options.launchMode,
          ports,
          fileCount: files.length,
        },
      });
      await computeClient.writeFiles({
        instanceId: created.instanceId,
        files,
        signal: bootstrapSignal,
      });
      await options.onMutation?.({
        provider: 'blaxel',
        operation: 'write_files',
        eventType: 'completed',
        instanceId: created.instanceId,
        message: `writeFiles completed for Blaxel sandbox ${created.instanceId}.`,
        details: {
          launchMode: options.launchMode,
          ports,
          fileCount: files.length,
        },
      });
      const install = await computeClient.runCommand({
        instanceId: created.instanceId,
        cmd: 'bash',
        args: [INSTALL_SCRIPT_PATH],
        // Blaxel's injected sandbox API runs commands as root even when the
        // source image declares USER roomote. Point HOME back at the worker
        // user's mise config so the image's pinned Node toolchain is active.
        env: {
          HOME: '/home/roomote',
          WORKER_RELEASE_ARCHIVE_PATH: WORKER_TARBALL_PATH,
        },
        signal: bootstrapSignal,
      });
      if (install.exitCode !== 0) {
        throw new Error(
          `Blaxel worker install failed with exit code ${install.exitCode}: ${install.stderr ?? install.stdout ?? 'no output'}`,
        );
      }
    } catch (error) {
      await computeClient
        .destroyInstance({ instanceId: created.instanceId })
        .catch((cleanupError) => {
          console.error('[createBlaxelMachine] Cleanup failed', cleanupError);
        });
      throw error;
    }
  }

  return {
    machineId: created.instanceId,
    proxyPorts,
    ...(options.resumeHandle ? { sourceSnapshotId: options.resumeHandle } : {}),
    domain: (port) => {
      const domain = created.domains?.[String(port)];
      if (!domain) {
        throw new Error(
          `Blaxel sandbox ${created.instanceId} has no preview URL for port ${port}`,
        );
      }
      return domain;
    },
  };
}
