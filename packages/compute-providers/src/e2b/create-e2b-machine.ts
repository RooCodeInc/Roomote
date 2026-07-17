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
import { isAbortError, sleepWithSignal, throwIfAborted } from '../modal/abort';

import { cleanupE2bInstance } from './cleanup';

const MAX_RETRIES = 3;

const INITIAL_DELAY_MS = 2_000;

const E2B_FILES_DIR = SANDBOX_FILES_DIR;

const INSTALL_SCRIPT_PATH = `${E2B_FILES_DIR}/install-worker.sh`;

const WORKER_TARBALL_PATH = `${E2B_FILES_DIR}/worker.tar.gz`;

const DEFAULT_E2B_DOMAIN = 'e2b.app';

type E2bLifecycleClient = Pick<
  ComputeProviderClient,
  | 'vendor'
  | 'createInstance'
  | 'resumeFromSnapshot'
  | 'writeFiles'
  | 'runCommand'
  | 'destroyInstance'
>;

export interface CreateE2bMachineOptions {
  e2bApiKey: string;
  e2bDomain?: string;
  e2bTemplateId: string;
  ports?: number[];
  namedPorts?: NamedPort[];
  /**
   * Optional proxy port mapping override. When omitted, proxy ports are generated.
   */
  proxyPorts?: Record<string, number>;
  timeoutMs?: number;
  localTarballPath?: string;
  /**
   * Timeout for sandbox creation (includes cold template pulls).
   */
  createInstanceTimeoutMs?: number;
  /**
   * Timeout for file writes + install script after the instance is running.
   */
  bootstrapTimeoutMs?: number;
  tags?: Record<string, string>;
  signal?: AbortSignal;
  computeClient?: E2bLifecycleClient;
  onMutation?: ComputeProviderMutationObserver;
}

export type E2bLaunchOptions =
  | { launchMode: 'fresh'; sourceSnapshotId?: undefined }
  | { launchMode: 'environment_snapshot'; sourceSnapshotId: string }
  | { launchMode: 'task_snapshot'; sourceSnapshotId: string };

export type CreateE2bMachineParams = CreateE2bMachineOptions & E2bLaunchOptions;

export interface E2bMachine {
  machineId: string;
  proxyPorts?: Record<string, number>;
  sourceSnapshotId?: string;
  domain: (port: number) => string;
}

export async function createE2bMachine(
  options: CreateE2bMachineParams,
): Promise<E2bMachine> {
  const {
    e2bApiKey,
    e2bDomain,
    e2bTemplateId,
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

  // A task snapshot owns repository and harness-session state, but its worker
  // must speak the current API/runtime protocol (for example inference-gateway
  // env markers). Refresh only the shipped worker directory after restore.
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
    launchMode: launchMode as ComputeProviderLaunchMode,
    sourceSnapshotId: sourceSnapshotId ?? null,
    ports: effectivePorts ?? [],
  };

  console.log(
    `[createE2bMachine] Starting ${JSON.stringify({
      hasLocalTarball: !!localTarballPath,
      hasSourceSnapshot: !!sourceSnapshotId,
      launchMode,
      workerReleaseTag,
      effectivePorts,
      proxyPorts,
      e2bDomain: e2bDomain ?? '(default)',
      e2bTemplateId,
      tags,
    })}`,
  );

  const computeClient =
    options.computeClient ??
    createComputeProviderClient({
      provider: 'e2b',
      config: {
        apiKey: e2bApiKey,
        templateId: e2bTemplateId,
        ...(e2bDomain ? { domain: e2bDomain } : {}),
        ...(timeoutMs ? { timeoutMs } : {}),
      },
    });

  if (computeClient.vendor !== 'e2b') {
    throw new Error('createE2bMachine requires an E2B compute client');
  }

  const fallbackDomain = (instanceId: string, port: number): string =>
    `https://${port}-${instanceId}.${e2bDomain ?? DEFAULT_E2B_DOMAIN}`;

  let createdMachine:
    | { instanceId: string; domains?: Record<string, string> }
    | undefined;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    throwIfAborted(createInstanceSignal);

    console.log(
      `[createE2bMachine] Attempt ${attempt}/${MAX_RETRIES}: ${sourceSnapshotId ? 'resumeFromSnapshot' : 'createInstance'}`,
    );

    try {
      const operation = sourceSnapshotId
        ? 'resume_from_snapshot'
        : 'create_instance';

      await onMutation?.({
        provider: 'e2b',
        operation,
        eventType: 'started',
        message:
          operation === 'resume_from_snapshot'
            ? `Calling resumeFromSnapshot for E2B instance from snapshot ${sourceSnapshotId}.`
            : 'Calling createInstance for E2B instance.',
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
        provider: 'e2b',
        operation,
        eventType: 'completed',
        instanceId: instance.instanceId,
        message: `${
          operation === 'resume_from_snapshot'
            ? 'resumeFromSnapshot'
            : 'createInstance'
        } completed for E2B instance ${instance.instanceId}.`,
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
        `[createE2bMachine] Instance created ${JSON.stringify({
          instanceId: instance.instanceId,
          domains: instance.domains,
          sourceSnapshotId: instance.sourceSnapshotId,
        })}`,
      );

      break;
    } catch (error) {
      await onMutation?.({
        provider: 'e2b',
        operation: sourceSnapshotId
          ? 'resume_from_snapshot'
          : 'create_instance',
        eventType: 'failed',
        message: `${
          sourceSnapshotId ? 'resumeFromSnapshot' : 'createInstance'
        } failed for E2B instance.`,
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
          `[createE2bMachine] Aborting retries after cancellation ${JSON.stringify(
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
          `[createE2bMachine] Failed after ${MAX_RETRIES} attempts ${JSON.stringify(errorInfo)}`,
        );

        throw error;
      }

      const delayMs = INITIAL_DELAY_MS * Math.pow(2, attempt - 1);

      console.warn(
        `[createE2bMachine] Attempt ${attempt}/${MAX_RETRIES} failed, retrying in ${delayMs}ms ${JSON.stringify(errorInfo)}`,
      );

      await sleepWithSignal(delayMs, createInstanceSignal);
    }
  }

  if (!createdMachine) {
    throw new Error('Failed to create E2B instance');
  }

  // Start the bootstrap timeout only after instance creation succeeds, so cold
  // template pulls don't eat into the bootstrap budget.
  const bootstrapSignal =
    bootstrapTimeoutMs != null
      ? AbortSignal.timeout(bootstrapTimeoutMs)
      : legacySignal;

  let bootstrapPhase = 'load-files';

  try {
    const { files: filesToWrite } = loadE2bFiles();

    if (tarball) {
      filesToWrite.push({ path: WORKER_TARBALL_PATH, content: tarball });
      console.log(
        `[createE2bMachine] Worker tarball added ${JSON.stringify({
          path: WORKER_TARBALL_PATH,
          sizeBytes: tarball.byteLength,
        })}`,
      );
    }

    if (filesToWrite.length > 0) {
      bootstrapPhase = 'write-files';

      await onMutation?.({
        provider: 'e2b',
        operation: 'write_files',
        eventType: 'started',
        instanceId: createdMachine.instanceId,
        message: `Calling writeFiles for E2B instance ${createdMachine.instanceId}.`,
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
        provider: 'e2b',
        operation: 'write_files',
        eventType: 'completed',
        instanceId: createdMachine.instanceId,
        message: `writeFiles completed for E2B instance ${createdMachine.instanceId}.`,
        details: buildComputeProviderMutationDetails(mutationContext, {
          phase: 'bootstrap_upload',
          fileCount: filesToWrite.length,
          filePaths: filesToWrite.map((file) => file.path),
        }),
      });
    }

    bootstrapPhase = 'install-worker';

    console.log(
      `[createE2bMachine] Running install script: bash ${INSTALL_SCRIPT_PATH}`,
    );

    await onMutation?.({
      provider: 'e2b',
      operation: 'run_command',
      eventType: 'started',
      instanceId: createdMachine.instanceId,
      message: `Calling runCommand for E2B instance ${createdMachine.instanceId}.`,
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
              // Fresh E2B boots stage the worker release under the shared
              // sandbox files directory so the install script can reuse the
              // same default path as Vercel sandbox.
              WORKER_RELEASE_ARCHIVE_PATH: WORKER_TARBALL_PATH,
            },
          }
        : {}),
      signal: bootstrapSignal,
    });

    await onMutation?.({
      provider: 'e2b',
      operation: 'run_command',
      eventType: 'completed',
      instanceId: createdMachine.instanceId,
      message: `runCommand completed for E2B instance ${createdMachine.instanceId}.`,
      details: buildComputeProviderMutationDetails(mutationContext, {
        phase: 'install_worker',
        command: 'bash',
        args: [INSTALL_SCRIPT_PATH],
        exitCode: installResult.exitCode,
      }),
    });

    if (installResult.exitCode !== 0) {
      throw new Error(
        `E2B worker install failed with exit code ${installResult.exitCode ?? 'null'}: ${installResult.stderr ?? installResult.stdout ?? 'no output'}`,
      );
    }
  } catch (error) {
    if (bootstrapPhase === 'write-files') {
      await onMutation?.({
        provider: 'e2b',
        operation: 'write_files',
        eventType: 'failed',
        instanceId: createdMachine.instanceId,
        message: `writeFiles failed for E2B instance ${createdMachine.instanceId}.`,
        details: buildComputeProviderMutationDetails(mutationContext, {
          phase: 'bootstrap_upload',
          error: error instanceof Error ? error.message : String(error),
        }),
      });
    } else if (bootstrapPhase === 'install-worker') {
      await onMutation?.({
        provider: 'e2b',
        operation: 'run_command',
        eventType: 'failed',
        instanceId: createdMachine.instanceId,
        message: `runCommand failed for E2B instance ${createdMachine.instanceId}.`,
        details: buildComputeProviderMutationDetails(mutationContext, {
          phase: 'install_worker',
          command: 'bash',
          args: [INSTALL_SCRIPT_PATH],
          error: error instanceof Error ? error.message : String(error),
        }),
      });
    }

    await cleanupE2bInstance({
      computeClient,
      instanceId: createdMachine.instanceId,
      phase: bootstrapPhase,
      error,
      logPrefix: 'createE2bMachine',
      onMutation,
      ...mutationContext,
    });

    throw error;
  }

  return {
    machineId: createdMachine.instanceId,
    proxyPorts,
    ...(sourceSnapshotId ? { sourceSnapshotId } : {}),
    domain: (port: number) =>
      createdMachine.domains?.[port.toString()] ??
      fallbackDomain(createdMachine.instanceId, port),
  };
}

function loadE2bFiles(): LoadedSandboxBootstrapFiles {
  const loadedFiles = loadSandboxBootstrapFiles(E2B_FILES_DIR);

  if (loadedFiles.ignoredFiles.length > 0) {
    console.log(
      `[createE2bMachine] Ignoring non-bootstrap E2B files ${JSON.stringify({
        localDir: loadedFiles.localDir,
        ignoredFiles: loadedFiles.ignoredFiles,
      })}`,
    );
  }

  return loadedFiles;
}
