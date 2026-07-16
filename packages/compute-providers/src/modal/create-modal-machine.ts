import {
  type ComputeProviderLaunchMode,
  type NamedPort,
  SANDBOX_FILES_DIR,
} from '@roomote/types';

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

import { isAbortError, sleepWithSignal, throwIfAborted } from './abort';
import { cleanupModalInstance } from './cleanup';

const MAX_RETRIES = 3;

const INITIAL_DELAY_MS = 2_000;

const MODAL_FILES_DIR = SANDBOX_FILES_DIR;

const INSTALL_SCRIPT_PATH = `${MODAL_FILES_DIR}/install-worker.sh`;

const WORKER_TARBALL_PATH = `${MODAL_FILES_DIR}/worker.tar.gz`;

type ModalLifecycleClient = Pick<
  ComputeProviderClient,
  | 'vendor'
  | 'createInstance'
  | 'resumeFromSnapshot'
  | 'writeFiles'
  | 'runCommand'
  | 'destroyInstance'
>;

export interface CreateModalMachineOptions {
  modalTokenId: string;
  modalTokenSecret: string;
  modalEndpoint?: string;
  modalEnvironment?: string;
  modalAppName?: string;
  modalBaseImageRef: string;
  modalRegistryUsername?: string;
  modalRegistryPassword?: string;
  modalEcrOidcRoleArn?: string;
  modalEcrRegion?: string;
  ports?: number[];
  namedPorts?: NamedPort[];
  /**
   * Optional proxy port mapping override. When omitted, proxy ports are generated.
   */
  proxyPorts?: Record<string, number>;
  timeoutMs?: number;
  localTarballPath?: string;
  /**
   * Timeout for sandbox creation (includes cold image pulls).
   */
  createInstanceTimeoutMs?: number;
  /**
   * Timeout for file writes + install script after the instance is running.
   */
  bootstrapTimeoutMs?: number;
  /**
   * @deprecated Use createInstanceTimeoutMs and bootstrapTimeoutMs instead.
   * When set and the new options are not provided, this single timeout covers
   * the entire flow (legacy behaviour).
   */
  tags?: Record<string, string>;
  signal?: AbortSignal;
  computeClient?: ModalLifecycleClient;
  onMutation?: ComputeProviderMutationObserver;
}

export type ModalLaunchOptions =
  | { launchMode: 'fresh'; sourceSnapshotId?: undefined }
  | { launchMode: 'environment_snapshot'; sourceSnapshotId: string }
  | { launchMode: 'task_snapshot'; sourceSnapshotId: string };

export type CreateModalMachineParams = CreateModalMachineOptions &
  ModalLaunchOptions;

export interface ModalMachine {
  machineId: string;
  proxyPorts?: Record<string, number>;
  sourceSnapshotId?: string;
  domain: (port: number) => string;
}

export async function createModalMachine(
  options: CreateModalMachineParams,
): Promise<ModalMachine> {
  const {
    modalTokenId,
    modalTokenSecret,
    modalEndpoint,
    modalEnvironment,
    modalAppName,
    modalBaseImageRef,
    modalRegistryUsername,
    modalRegistryPassword,
    modalEcrOidcRoleArn,
    modalEcrRegion,
    ports,
    namedPorts,
    timeoutMs,
    proxyPorts: proxyPortsOverride,
    localTarballPath,
    launchMode,
    sourceSnapshotId,
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
  const shouldInstallShippedRuntime = launchMode !== 'task_snapshot';

  if (shouldInstallShippedRuntime && localTarballPath) {
    const localRelease = loadLocalWorkerReleaseWithVersion(localTarballPath);
    tarball = localRelease.archive;
    version = localRelease.version;
  } else if (shouldInstallShippedRuntime) {
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
    launchMode: launchMode as ComputeProviderLaunchMode,
    sourceSnapshotId: sourceSnapshotId ?? null,
    ports: effectivePorts ?? [],
  };

  console.log(
    `[createModalMachine] Starting ${JSON.stringify({
      hasLocalTarball: !!localTarballPath,
      hasSourceSnapshot: !!sourceSnapshotId,
      launchMode,
      workerReleaseTag,
      effectivePorts,
      proxyPorts,
      modalEndpoint: modalEndpoint ?? '(default)',
      modalEnvironment: modalEnvironment ?? '(default)',
      modalAppName: modalAppName ?? '(default)',
      modalBaseImageRef,
      tags,
    })}`,
  );

  const computeClient =
    options.computeClient ??
    createComputeProviderClient({
      provider: 'modal',
      config: {
        tokenId: modalTokenId,
        tokenSecret: modalTokenSecret,
        ...(modalEndpoint ? { endpoint: modalEndpoint } : {}),
        ...(modalEnvironment ? { environment: modalEnvironment } : {}),
        ...(modalAppName ? { appName: modalAppName } : {}),
        baseImageRef: modalBaseImageRef,
        ...(modalRegistryUsername
          ? { registryUsername: modalRegistryUsername }
          : {}),
        ...(modalRegistryPassword
          ? { registryPassword: modalRegistryPassword }
          : {}),
        ...(modalEcrOidcRoleArn ? { ecrOidcRoleArn: modalEcrOidcRoleArn } : {}),
        ...(modalEcrRegion ? { ecrRegion: modalEcrRegion } : {}),
        ...(timeoutMs ? { timeoutMs } : {}),
      },
    });

  if (computeClient.vendor !== 'modal' && computeClient.vendor !== 'roomote') {
    throw new Error('createModalMachine requires a Modal compute client');
  }

  let createdMachine:
    | { instanceId: string; domains?: Record<string, string> }
    | undefined;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    throwIfAborted(createInstanceSignal);

    console.log(
      `[createModalMachine] Attempt ${attempt}/${MAX_RETRIES}: ${sourceSnapshotId ? 'resumeFromSnapshot' : 'createInstance'}`,
    );

    try {
      const operation = sourceSnapshotId
        ? 'resume_from_snapshot'
        : 'create_instance';

      await onMutation?.({
        provider: computeClient.vendor,
        operation,
        eventType: 'started',
        message:
          operation === 'resume_from_snapshot'
            ? `Calling resumeFromSnapshot for Modal instance from snapshot ${sourceSnapshotId}.`
            : 'Calling createInstance for Modal instance.',
        details: buildComputeProviderMutationDetails(
          { ...mutationContext, attempt },
          {},
        ),
      });

      const instance = sourceSnapshotId
        ? await computeClient.resumeFromSnapshot({
            sourceSnapshotId,
            ports: effectivePorts,
            tags,
            metadata: {
              ...(workerReleaseTag ? { workerReleaseTag } : {}),
              ...(timeoutMs ? { timeoutMs: String(timeoutMs) } : {}),
            },
            signal: createInstanceSignal,
          })
        : await computeClient.createInstance({
            ports: effectivePorts,
            tags,
            metadata: {
              ...(workerReleaseTag ? { workerReleaseTag } : {}),
              ...(timeoutMs ? { timeoutMs: String(timeoutMs) } : {}),
            },
            signal: createInstanceSignal,
          });

      await onMutation?.({
        provider: computeClient.vendor,
        operation,
        eventType: 'completed',
        instanceId: instance.instanceId,
        message: `${
          operation === 'resume_from_snapshot'
            ? 'resumeFromSnapshot'
            : 'createInstance'
        } completed for Modal instance ${instance.instanceId}.`,
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
        `[createModalMachine] Instance created ${JSON.stringify({
          instanceId: instance.instanceId,
          domains: instance.domains,
          sourceSnapshotId: instance.sourceSnapshotId,
        })}`,
      );

      break;
    } catch (error) {
      await onMutation?.({
        provider: computeClient.vendor,
        operation: sourceSnapshotId
          ? 'resume_from_snapshot'
          : 'create_instance',
        eventType: 'failed',
        message: `${
          sourceSnapshotId ? 'resumeFromSnapshot' : 'createInstance'
        } failed for Modal instance.`,
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
              code: (error as Error & { code?: string }).code,
              details: (error as Error & { details?: string }).details,
              stack: error.stack,
            }
          : { message: String(error) };

      if (isAbortError(error)) {
        console.warn(
          `[createModalMachine] Aborting retries after cancellation ${JSON.stringify(
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
          `[createModalMachine] Failed after ${MAX_RETRIES} attempts ${JSON.stringify(errorInfo)}`,
        );

        throw error;
      }

      const delayMs = INITIAL_DELAY_MS * Math.pow(2, attempt - 1);

      console.warn(
        `[createModalMachine] Attempt ${attempt}/${MAX_RETRIES} failed, retrying in ${delayMs}ms ${JSON.stringify(errorInfo)}`,
      );

      await sleepWithSignal(delayMs, createInstanceSignal);
    }
  }

  if (!createdMachine) {
    throw new Error('Failed to create modal instance');
  }

  if (!shouldInstallShippedRuntime) {
    return {
      machineId: createdMachine.instanceId,
      proxyPorts,
      ...(sourceSnapshotId ? { sourceSnapshotId } : {}),
      domain: (port: number) => {
        const fromResponse =
          createdMachine.domains?.[port.toString()] ??
          createdMachine.domains?.[`${port}`];

        if (fromResponse) {
          return fromResponse;
        }

        return `https://${createdMachine.instanceId}-${port}.modal.run`;
      },
    };
  }

  // Start the bootstrap timeout only after instance creation succeeds, so cold
  // image pulls don't eat into the bootstrap budget.
  const bootstrapSignal =
    bootstrapTimeoutMs != null
      ? AbortSignal.timeout(bootstrapTimeoutMs)
      : legacySignal;

  let bootstrapPhase = 'load-files';

  try {
    const { files: filesToWrite } = loadModalFiles();

    if (tarball) {
      filesToWrite.push({ path: WORKER_TARBALL_PATH, content: tarball });
      console.log(
        `[createModalMachine] Worker tarball added ${JSON.stringify({
          path: WORKER_TARBALL_PATH,
          sizeBytes: tarball.byteLength,
        })}`,
      );
    }

    if (filesToWrite.length > 0) {
      bootstrapPhase = 'write-files';

      await onMutation?.({
        provider: computeClient.vendor,
        operation: 'write_files',
        eventType: 'started',
        instanceId: createdMachine.instanceId,
        message: `Calling writeFiles for Modal instance ${createdMachine.instanceId}.`,
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
        provider: computeClient.vendor,
        operation: 'write_files',
        eventType: 'completed',
        instanceId: createdMachine.instanceId,
        message: `writeFiles completed for Modal instance ${createdMachine.instanceId}.`,
        details: buildComputeProviderMutationDetails(mutationContext, {
          phase: 'bootstrap_upload',
          fileCount: filesToWrite.length,
          filePaths: filesToWrite.map((file) => file.path),
        }),
      });
    }

    bootstrapPhase = 'install-worker';

    console.log(
      `[createModalMachine] Running install script: sh ${INSTALL_SCRIPT_PATH}`,
    );

    await onMutation?.({
      provider: computeClient.vendor,
      operation: 'run_command',
      eventType: 'started',
      instanceId: createdMachine.instanceId,
      message: `Calling runCommand for Modal instance ${createdMachine.instanceId}.`,
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
              // Fresh Modal boots stage the worker release under the shared
              // sandbox files directory so the install script can reuse the
              // same default path as Vercel sandbox.
              WORKER_RELEASE_ARCHIVE_PATH: WORKER_TARBALL_PATH,
            },
          }
        : {}),
      signal: bootstrapSignal,
    });

    await onMutation?.({
      provider: computeClient.vendor,
      operation: 'run_command',
      eventType: 'completed',
      instanceId: createdMachine.instanceId,
      message: `runCommand completed for Modal instance ${createdMachine.instanceId}.`,
      details: buildComputeProviderMutationDetails(mutationContext, {
        phase: 'install_worker',
        command: 'bash',
        args: [INSTALL_SCRIPT_PATH],
        exitCode: installResult.exitCode,
      }),
    });

    if (installResult.exitCode !== 0) {
      throw new Error(
        `Modal worker install failed with exit code ${installResult.exitCode ?? 'null'}: ${installResult.stderr ?? installResult.stdout ?? 'no output'}`,
      );
    }
  } catch (error) {
    if (bootstrapPhase === 'write-files') {
      await onMutation?.({
        provider: computeClient.vendor,
        operation: 'write_files',
        eventType: 'failed',
        instanceId: createdMachine.instanceId,
        message: `writeFiles failed for Modal instance ${createdMachine.instanceId}.`,
        details: buildComputeProviderMutationDetails(mutationContext, {
          phase: 'bootstrap_upload',
          error: error instanceof Error ? error.message : String(error),
        }),
      });
    } else if (bootstrapPhase === 'install-worker') {
      await onMutation?.({
        provider: computeClient.vendor,
        operation: 'run_command',
        eventType: 'failed',
        instanceId: createdMachine.instanceId,
        message: `runCommand failed for Modal instance ${createdMachine.instanceId}.`,
        details: buildComputeProviderMutationDetails(mutationContext, {
          phase: 'install_worker',
          command: 'bash',
          args: [INSTALL_SCRIPT_PATH],
          error: error instanceof Error ? error.message : String(error),
        }),
      });
    }

    await cleanupModalInstance({
      computeClient,
      instanceId: createdMachine.instanceId,
      phase: bootstrapPhase,
      error,
      logPrefix: 'createModalMachine',
      onMutation,
      ...mutationContext,
    });

    throw error;
  }

  return {
    machineId: createdMachine.instanceId,
    proxyPorts,
    ...(sourceSnapshotId ? { sourceSnapshotId } : {}),
    domain: (port: number) => {
      const fromResponse =
        createdMachine.domains?.[port.toString()] ??
        createdMachine.domains?.[`${port}`];

      if (fromResponse) {
        return fromResponse;
      }

      // Fallback when Modal API does not return an explicit domain map.
      return `https://${createdMachine.instanceId}-${port}.modal.run`;
    },
  };
}

function loadModalFiles(): LoadedSandboxBootstrapFiles {
  const loadedFiles = loadSandboxBootstrapFiles(MODAL_FILES_DIR);

  if (loadedFiles.ignoredFiles.length > 0) {
    console.log(
      `[createModalMachine] Ignoring non-bootstrap Modal files ${JSON.stringify(
        {
          localDir: loadedFiles.localDir,
          ignoredFiles: loadedFiles.ignoredFiles,
        },
      )}`,
    );
  }

  return loadedFiles;
}
