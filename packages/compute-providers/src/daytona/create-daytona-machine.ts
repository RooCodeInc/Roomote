import { type NamedPort, SANDBOX_FILES_DIR } from '@roomote/types';

import { createComputeProviderClient } from '../factory';
import { generateProxyPorts, getExposedPorts } from '../environment-machine';
import { buildComputeProviderMutationDetails } from '../mutation-events';
import type {
  ComputeProviderClient,
  ComputeProviderMutationObserver,
} from '../types';
import { loadLocalWorkerReleaseWithVersion } from '../sandbox/utils';
import { getWorkerRelease } from '../sandbox/worker-release-cache';
import {
  type LoadedSandboxBootstrapFiles,
  loadSandboxBootstrapFiles,
} from '../sandbox/bootstrap-files';
import { isAbortError, sleepWithSignal, throwIfAborted } from '../modal/abort';

import { cleanupDaytonaInstance } from './cleanup';

const MAX_RETRIES = 3;

const INITIAL_DELAY_MS = 2_000;

const DAYTONA_FILES_DIR = SANDBOX_FILES_DIR;

const INSTALL_SCRIPT_PATH = `${DAYTONA_FILES_DIR}/install-worker.sh`;

const WORKER_TARBALL_PATH = `${DAYTONA_FILES_DIR}/worker.tar.gz`;

type DaytonaLifecycleClient = Pick<
  ComputeProviderClient,
  'vendor' | 'createInstance' | 'writeFiles' | 'runCommand' | 'destroyInstance'
>;

export interface CreateDaytonaMachineOptions {
  daytonaApiKey: string;
  daytonaApiUrl?: string;
  daytonaTarget?: string;
  daytonaSnapshotName: string;
  ports?: number[];
  namedPorts?: NamedPort[];
  /**
   * Optional proxy port mapping override. When omitted, proxy ports are generated.
   */
  proxyPorts?: Record<string, number>;
  timeoutMs?: number;
  localTarballPath?: string;
  /**
   * Timeout for sandbox creation (includes cold snapshot pulls).
   */
  createInstanceTimeoutMs?: number;
  /**
   * Timeout for file writes + install script after the instance is running.
   */
  bootstrapTimeoutMs?: number;
  tags?: Record<string, string>;
  signal?: AbortSignal;
  computeClient?: DaytonaLifecycleClient;
  onMutation?: ComputeProviderMutationObserver;
}

export interface DaytonaMachine {
  machineId: string;
  proxyPorts?: Record<string, number>;
  domain: (port: number) => string;
}

/**
 * Daytona machines only support fresh launches today: no environment or task
 * snapshots. Callers gate snapshot job types before reaching this helper.
 */
export async function createDaytonaMachine(
  options: CreateDaytonaMachineOptions,
): Promise<DaytonaMachine> {
  const {
    daytonaApiKey,
    daytonaApiUrl,
    daytonaTarget,
    daytonaSnapshotName,
    ports,
    namedPorts,
    timeoutMs,
    proxyPorts: proxyPortsOverride,
    localTarballPath,
    createInstanceTimeoutMs,
    bootstrapTimeoutMs,
    tags,
    signal: legacySignal,
    onMutation,
  } = options;

  const createInstanceSignal =
    createInstanceTimeoutMs != null
      ? AbortSignal.timeout(createInstanceTimeoutMs)
      : legacySignal;

  throwIfAborted(createInstanceSignal);

  let tarball: Buffer | undefined;
  let version: string | undefined;

  if (localTarballPath) {
    const localRelease = loadLocalWorkerReleaseWithVersion(localTarballPath);
    tarball = localRelease.archive;
    version = localRelease.version;
  } else {
    const release = await getWorkerRelease();
    tarball = release.archive;
    version = release.version;
  }

  const workerReleaseTag = version ? `worker-v${version}` : undefined;

  const proxyPorts = proxyPortsOverride ?? generateProxyPorts(namedPorts);

  const effectivePorts =
    namedPorts && namedPorts.length > 0
      ? getExposedPorts(namedPorts, proxyPorts)
      : ports;

  const mutationContext = {
    launchMode: 'fresh' as const,
    sourceSnapshotId: null,
    ports: effectivePorts ?? [],
  };

  console.log(
    `[createDaytonaMachine] Starting ${JSON.stringify({
      hasLocalTarball: !!localTarballPath,
      workerReleaseTag,
      effectivePorts,
      proxyPorts,
      daytonaApiUrl: daytonaApiUrl ?? '(default)',
      daytonaTarget: daytonaTarget ?? '(default)',
      daytonaSnapshotName,
      tags,
    })}`,
  );

  const computeClient =
    options.computeClient ??
    createComputeProviderClient({
      provider: 'daytona',
      config: {
        apiKey: daytonaApiKey,
        snapshotName: daytonaSnapshotName,
        ...(daytonaApiUrl ? { apiUrl: daytonaApiUrl } : {}),
        ...(daytonaTarget ? { target: daytonaTarget } : {}),
        ...(timeoutMs ? { timeoutMs } : {}),
      },
    });

  if (computeClient.vendor !== 'daytona') {
    throw new Error('createDaytonaMachine requires a Daytona compute client');
  }

  let createdMachine:
    | { instanceId: string; domains?: Record<string, string> }
    | undefined;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    throwIfAborted(createInstanceSignal);

    console.log(
      `[createDaytonaMachine] Attempt ${attempt}/${MAX_RETRIES}: createInstance`,
    );

    try {
      await onMutation?.({
        provider: 'daytona',
        operation: 'create_instance',
        eventType: 'started',
        message: 'Calling createInstance for Daytona instance.',
        details: buildComputeProviderMutationDetails(
          { ...mutationContext, attempt },
          {},
        ),
      });

      const instance = await computeClient.createInstance({
        ports: effectivePorts,
        tags,
        metadata: {
          ...(workerReleaseTag ? { workerReleaseTag } : {}),
          ...(timeoutMs ? { timeoutMs: String(timeoutMs) } : {}),
        },
        signal: createInstanceSignal,
      });

      await onMutation?.({
        provider: 'daytona',
        operation: 'create_instance',
        eventType: 'completed',
        instanceId: instance.instanceId,
        message: `createInstance completed for Daytona instance ${instance.instanceId}.`,
        details: buildComputeProviderMutationDetails(
          { ...mutationContext, attempt },
          {},
        ),
      });

      createdMachine = {
        instanceId: instance.instanceId,
        domains: instance.domains,
      };

      console.log(
        `[createDaytonaMachine] Instance created ${JSON.stringify({
          instanceId: instance.instanceId,
          domains: instance.domains,
        })}`,
      );

      break;
    } catch (error) {
      await onMutation?.({
        provider: 'daytona',
        operation: 'create_instance',
        eventType: 'failed',
        message: 'createInstance failed for Daytona instance.',
        details: buildComputeProviderMutationDetails(
          { ...mutationContext, attempt },
          {
            error: error instanceof Error ? error.message : String(error),
          },
        ),
      });

      const errorInfo =
        error instanceof Error
          ? {
              name: error.name,
              message: error.message,
              stack: error.stack,
            }
          : { message: String(error) };

      if (isAbortError(error)) {
        console.warn(
          `[createDaytonaMachine] Aborting retries after cancellation ${JSON.stringify(
            {
              attempt,
              error: errorInfo,
            },
          )}`,
        );

        throw error;
      }

      if (attempt === MAX_RETRIES) {
        console.error(
          `[createDaytonaMachine] Failed after ${MAX_RETRIES} attempts ${JSON.stringify(errorInfo)}`,
        );

        throw error;
      }

      const delayMs = INITIAL_DELAY_MS * Math.pow(2, attempt - 1);

      console.warn(
        `[createDaytonaMachine] Attempt ${attempt}/${MAX_RETRIES} failed, retrying in ${delayMs}ms ${JSON.stringify(errorInfo)}`,
      );

      await sleepWithSignal(delayMs, createInstanceSignal);
    }
  }

  if (!createdMachine) {
    throw new Error('Failed to create Daytona instance');
  }

  // Start the bootstrap timeout only after instance creation succeeds, so cold
  // snapshot pulls don't eat into the bootstrap budget.
  const bootstrapSignal =
    bootstrapTimeoutMs != null
      ? AbortSignal.timeout(bootstrapTimeoutMs)
      : legacySignal;

  let bootstrapPhase = 'load-files';

  try {
    const { files: filesToWrite } = loadDaytonaFiles();

    if (tarball) {
      filesToWrite.push({ path: WORKER_TARBALL_PATH, content: tarball });
      console.log(
        `[createDaytonaMachine] Worker tarball added ${JSON.stringify({
          path: WORKER_TARBALL_PATH,
          sizeBytes: tarball.byteLength,
        })}`,
      );
    }

    if (filesToWrite.length > 0) {
      bootstrapPhase = 'write-files';

      await onMutation?.({
        provider: 'daytona',
        operation: 'write_files',
        eventType: 'started',
        instanceId: createdMachine.instanceId,
        message: `Calling writeFiles for Daytona instance ${createdMachine.instanceId}.`,
        details: buildComputeProviderMutationDetails(mutationContext, {
          phase: 'bootstrap_upload',
          fileCount: filesToWrite.length,
          filePaths: filesToWrite.map((file) => file.path),
        }),
      });

      await computeClient.writeFiles({
        instanceId: createdMachine.instanceId,
        files: filesToWrite,
        signal: bootstrapSignal,
      });

      await onMutation?.({
        provider: 'daytona',
        operation: 'write_files',
        eventType: 'completed',
        instanceId: createdMachine.instanceId,
        message: `writeFiles completed for Daytona instance ${createdMachine.instanceId}.`,
        details: buildComputeProviderMutationDetails(mutationContext, {
          phase: 'bootstrap_upload',
          fileCount: filesToWrite.length,
          filePaths: filesToWrite.map((file) => file.path),
        }),
      });
    }

    bootstrapPhase = 'install-worker';

    console.log(
      `[createDaytonaMachine] Running install script: bash ${INSTALL_SCRIPT_PATH}`,
    );

    await onMutation?.({
      provider: 'daytona',
      operation: 'run_command',
      eventType: 'started',
      instanceId: createdMachine.instanceId,
      message: `Calling runCommand for Daytona instance ${createdMachine.instanceId}.`,
      details: buildComputeProviderMutationDetails(mutationContext, {
        phase: 'install_worker',
        command: 'bash',
        args: [INSTALL_SCRIPT_PATH],
      }),
    });

    const installResult = await computeClient.runCommand({
      instanceId: createdMachine.instanceId,
      cmd: 'bash',
      args: [INSTALL_SCRIPT_PATH],
      ...(tarball
        ? {
            env: {
              // Fresh Daytona boots stage the worker release under the shared
              // sandbox files directory so the install script can reuse the
              // same default path as Vercel sandbox.
              WORKER_RELEASE_ARCHIVE_PATH: WORKER_TARBALL_PATH,
            },
          }
        : {}),
      signal: bootstrapSignal,
    });

    await onMutation?.({
      provider: 'daytona',
      operation: 'run_command',
      eventType: 'completed',
      instanceId: createdMachine.instanceId,
      message: `runCommand completed for Daytona instance ${createdMachine.instanceId}.`,
      details: buildComputeProviderMutationDetails(mutationContext, {
        phase: 'install_worker',
        command: 'bash',
        args: [INSTALL_SCRIPT_PATH],
        exitCode: installResult.exitCode,
      }),
    });

    if (installResult.exitCode !== 0) {
      throw new Error(
        `Daytona worker install failed with exit code ${installResult.exitCode ?? 'null'}: ${installResult.stderr ?? installResult.stdout ?? 'no output'}`,
      );
    }
  } catch (error) {
    if (bootstrapPhase === 'write-files') {
      await onMutation?.({
        provider: 'daytona',
        operation: 'write_files',
        eventType: 'failed',
        instanceId: createdMachine.instanceId,
        message: `writeFiles failed for Daytona instance ${createdMachine.instanceId}.`,
        details: buildComputeProviderMutationDetails(mutationContext, {
          phase: 'bootstrap_upload',
          error: error instanceof Error ? error.message : String(error),
        }),
      });
    } else if (bootstrapPhase === 'install-worker') {
      await onMutation?.({
        provider: 'daytona',
        operation: 'run_command',
        eventType: 'failed',
        instanceId: createdMachine.instanceId,
        message: `runCommand failed for Daytona instance ${createdMachine.instanceId}.`,
        details: buildComputeProviderMutationDetails(mutationContext, {
          phase: 'install_worker',
          command: 'bash',
          args: [INSTALL_SCRIPT_PATH],
          error: error instanceof Error ? error.message : String(error),
        }),
      });
    }

    await cleanupDaytonaInstance({
      computeClient,
      instanceId: createdMachine.instanceId,
      phase: bootstrapPhase,
      error,
      logPrefix: 'createDaytonaMachine',
      onMutation,
      ...mutationContext,
    });

    throw error;
  }

  return {
    machineId: createdMachine.instanceId,
    proxyPorts,
    domain: (port: number) => {
      const fromResponse = createdMachine.domains?.[port.toString()];

      if (fromResponse) {
        return fromResponse;
      }

      throw new Error(
        `No Daytona preview link resolved for port ${port} on ${createdMachine.instanceId}`,
      );
    },
  };
}

function loadDaytonaFiles(): LoadedSandboxBootstrapFiles {
  const loadedFiles = loadSandboxBootstrapFiles(DAYTONA_FILES_DIR);

  if (loadedFiles.ignoredFiles.length > 0) {
    console.log(
      `[createDaytonaMachine] Ignoring non-bootstrap Daytona files ${JSON.stringify(
        {
          localDir: loadedFiles.localDir,
          ignoredFiles: loadedFiles.ignoredFiles,
        },
      )}`,
    );
  }

  return loadedFiles;
}
