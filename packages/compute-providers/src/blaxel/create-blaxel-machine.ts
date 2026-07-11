import { type NamedPort, SANDBOX_FILES_DIR } from '@roomote/types';

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
  'vendor' | 'createInstance' | 'writeFiles' | 'runCommand' | 'destroyInstance'
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
  domain: (port: number) => string;
}

export async function createBlaxelMachine(
  options: CreateBlaxelMachineOptions,
): Promise<BlaxelMachine> {
  const proxyPorts =
    options.proxyPorts ?? generateProxyPorts(options.namedPorts);
  const ports = getExposedPorts(options.namedPorts, proxyPorts);
  const createSignal = options.createInstanceTimeoutMs
    ? AbortSignal.timeout(options.createInstanceTimeoutMs)
    : options.signal;
  throwIfAborted(createSignal);

  const release = options.localTarballPath
    ? loadLocalWorkerReleaseWithVersion(options.localTarballPath)
    : await getWorkerRelease();
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
      await options.onMutation?.({
        provider: 'blaxel',
        operation: 'create_instance',
        eventType: 'started',
        message: 'Calling createInstance for Blaxel sandbox.',
        details: { attempt, launchMode: 'fresh', ports },
      });
      created = await computeClient.createInstance({
        ports,
        tags: options.tags,
        metadata: {
          workerReleaseTag: `worker-v${release.version}`,
          ...(options.timeoutMs
            ? { timeoutMs: String(options.timeoutMs) }
            : {}),
        },
        signal: createSignal,
      });
      await options.onMutation?.({
        provider: 'blaxel',
        operation: 'create_instance',
        eventType: 'completed',
        instanceId: created.instanceId,
        message: `createInstance completed for Blaxel sandbox ${created.instanceId}.`,
        details: { attempt, launchMode: 'fresh', ports },
      });
      break;
    } catch (error) {
      await options.onMutation?.({
        provider: 'blaxel',
        operation: 'create_instance',
        eventType: 'failed',
        message: 'createInstance failed for Blaxel sandbox.',
        details: {
          attempt,
          launchMode: 'fresh',
          ports,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      if (isAbortError(error) || attempt === MAX_RETRIES) throw error;
      await sleepWithSignal(2_000 * 2 ** (attempt - 1), createSignal);
    }
  }
  if (!created) throw new Error('Failed to create Blaxel sandbox');

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
      details: { launchMode: 'fresh', ports, fileCount: files.length },
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
      details: { launchMode: 'fresh', ports, fileCount: files.length },
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

  return {
    machineId: created.instanceId,
    proxyPorts,
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
