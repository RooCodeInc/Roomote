import { existsSync } from 'node:fs';

import {
  buildPreviewProxyUrl,
  TaskPayloadKind,
  NonRetryableSpawnError,
  getPrimaryPortFromConfig,
  portNameToSlug,
  SANDBOX_SERVER_NAMED_PORT,
  TaskRunErrorCode,
  type NamedPort,
} from '@roomote/types';
import { Env, resolveAppEnv } from '@roomote/env';
import {
  taskRuns,
  db,
  eq,
  resolveEffectivePreviewRuntimeConfig,
  type TaskRun,
} from '@roomote/db/server';
import { stampTaskRunMilestone } from '@roomote/sdk/server';
import {
  buildDockerWorkerEnv,
  resolveAuthBypassHeaderName,
  resolveAuthBypassValue,
} from '@roomote/compute-providers';

import {
  getNamedPortsForTaskRun,
  shouldEnableAuthBypassForTaskRun,
  clearTaskRunMachine,
  updateTaskRunMachine,
} from '../utils';
import { resolveFromWorkspaceRoot } from '../repo-paths';
import {
  attachDockerEgressPolicy,
  buildDockerTaskDaemonResourceArgs,
  buildDockerWorkerLabels,
  buildDockerWorkerResourceArgs,
  docker,
  DockerBootError,
  getDockerTaskNetworkName,
  getDockerTaskDaemonContainerName,
  getDockerTaskWorkspaceVolumeName,
  getDockerWorkerContainerName,
  isAbortError,
  isUnsupportedDockerDiskLimitError,
  prepareDockerTaskNetwork,
  processListIncludesDockerWorkerRun,
  removeDockerSandboxResources,
  restoreDockerStandbyNetworking,
  type DockerCommand,
  type DockerWorkerEgressPolicy,
} from './docker-sandbox-security';
import { taskNeedsNestedDocker } from './task-sandbox-resources';

const DOCKER_CONTAINER_READY_COMMAND = 'sleep';
const DOCKER_CONTAINER_READY_ARGS = ['infinity'];
const DOCKER_WORKER_ARCHIVE_PATH = '/sandbox/worker.tar.gz';
const DOCKER_WORKER_ROOT = '/sandbox';
const DOCKER_INSTALL_WORKER_SCRIPT = `${DOCKER_WORKER_ROOT}/install-worker.sh`;
// Image pulls and cold worker installs can exceed 15s on first boot (self-host).
const DOCKER_WORKER_START_TIMEOUT_MS = 60_000;
const DOCKER_WORKER_START_POLL_MS = 500;
const DOCKER_TASK_DAEMON_IMAGE = 'docker:28-dind';
/** Upper bound for fresh Docker provisioning so a stuck daemon cannot hang forever. */
export const DOCKER_SPAWN_TIMEOUT_MS = 15 * 60 * 1_000;

/**
 * Fail fast, with precise categories, on environment problems that otherwise
 * surface as opaque docker run failures or worker start timeouts. Runs before
 * any sandbox resources are created so nothing needs cleanup on failure.
 */
export async function preflightDockerSpawn(
  runDocker: DockerCommand,
  image: string,
): Promise<void> {
  try {
    await runDocker(['version', '--format', '{{.Server.Version}}']);
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }

    throw new DockerBootError(
      TaskRunErrorCode.DockerDaemonUnreachable,
      error instanceof Error ? error.message : String(error),
    );
  }

  // The daemon is reachable (checked above), so an empty inspect result means
  // the image is absent locally. Pull explicitly so registry-hosted images
  // still work and pull time is attributed to preflight, not the start wait.
  const imageId = await runDocker(
    ['image', 'inspect', '--format', '{{.Id}}', image],
    { allowFailure: true },
  );

  if (imageId.trim()) {
    return;
  }

  try {
    await runDocker(['pull', image]);
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }

    throw new DockerBootError(
      TaskRunErrorCode.DockerImageMissing,
      [
        `Docker worker image ${image} is not available locally and could not be pulled.`,
        error instanceof Error ? error.message : String(error),
      ].join('\n\n'),
    );
  }
}

export async function spawnDockerWorker(
  taskRun: TaskRun,
  authToken: string,
  config: {
    image: string;
    platform: string;
    network?: string;
    dockerTimeoutMs: number;
    cpuLimit: number;
    memoryLimit: string;
    taskDaemonMemoryLimit: string;
    pidsLimit: number;
    diskLimit: string;
    allowUnboundedDisk: boolean;
    logMaxSize: string;
    logMaxFiles: number;
    egressPolicy: DockerWorkerEgressPolicy;
    localWorkerReleasePath?: string;
    deploymentSlug?: string;
    signal?: AbortSignal;
  },
): Promise<{ containerId: string }> {
  if (taskRun.payloadKind === TaskPayloadKind.SnapshotEnvironment) {
    throw new NonRetryableSpawnError(
      `Docker provider does not support ${taskRun.payloadKind} task run kinds`,
    );
  }

  const isStandbyResume =
    taskRun.payloadKind === TaskPayloadKind.SnapshotResume;
  if (isStandbyResume && !taskRun.sourceSnapshotId) {
    throw new NonRetryableSpawnError(
      `SnapshotResume task run #${taskRun.id} missing sourceSnapshotId`,
    );
  }

  if (!isStandbyResume && !config.localWorkerReleasePath) {
    throw new DockerBootError(
      TaskRunErrorCode.DockerReleaseArchiveMissing,
      'Docker provider requires a local worker release archive. TaskRun pnpm dev without --use-release.',
    );
  }

  if (
    !isStandbyResume &&
    config.localWorkerReleasePath &&
    !existsSync(config.localWorkerReleasePath)
  ) {
    throw new DockerBootError(
      TaskRunErrorCode.DockerReleaseArchiveMissing,
      `Docker worker release archive does not exist: ${config.localWorkerReleasePath}`,
    );
  }

  const { namedPorts, environmentConfig } =
    await getNamedPortsForTaskRun(taskRun);

  const shouldEnableAuthBypass = shouldEnableAuthBypassForTaskRun({
    environmentConfig,
    namedPorts,
  });

  const authBypassValue = shouldEnableAuthBypass
    ? resolveAuthBypassValue(environmentConfig)
    : undefined;

  const authBypassHeaderName = shouldEnableAuthBypass
    ? resolveAuthBypassHeaderName(environmentConfig)
    : undefined;

  const resolvedPreviewRuntimeConfig =
    await resolveEffectivePreviewRuntimeConfig({
      runtimeEnv: process.env,
      defaultPreviewProxyBaseUrl: Env.PREVIEW_PROXY_BASE_URL,
      defaultPreviewDomains: Env.PREVIEW_DOMAINS,
    });

  const containerName = isStandbyResume
    ? taskRun.sourceSnapshotId!
    : getDockerWorkerContainerName(taskRun.id);
  const sourceRunId = getDockerSourceRunId(containerName);
  const usesDockerProjects = await taskNeedsNestedDocker(
    taskRun,
    environmentConfig,
  );
  const taskDaemonContainerName =
    getDockerTaskDaemonContainerName(containerName);
  const taskWorkspaceVolumeName =
    getDockerTaskWorkspaceVolumeName(containerName);
  const controlNetwork = config.network?.trim();
  const portArgs = controlNetwork
    ? []
    : namedPorts.flatMap(({ port }) => ['-p', `127.0.0.1::${port}`]);

  // Retained containers are reaped by the standby retention policy instead of
  // Docker's --rm lifecycle, so their writable layer remains resumable.
  const autoRemoveContainer = shouldAutoRemoveDockerWorkerContainer(
    resolveAppEnv(process.env),
  );
  // Propagate cancellation to every provisioning docker CLI invocation. Cleanup
  // after failure intentionally uses the unbound docker() helper so an aborted
  // signal cannot skip sandbox teardown.
  const runDocker: DockerCommand = (args, options = {}) =>
    docker(args, { ...options, signal: config.signal ?? options.signal });
  const throwIfSpawnAborted = (): void => {
    config.signal?.throwIfAborted();
  };

  throwIfSpawnAborted();

  // Resume restarts a retained container, so daemon/image preflight only
  // applies to fresh spawns.
  if (!isStandbyResume) {
    await preflightDockerSpawn(runDocker, config.image);
  }

  // Network name is deterministic so outer cleanup can tear it down even if
  // prepare is interrupted before returning.
  let dockerNetwork = isStandbyResume
    ? getDockerTaskNetworkName(sourceRunId)
    : getDockerTaskNetworkName(taskRun.id);

  console.log(
    `[spawnDockerWorker] Starting Docker worker container for task run #${taskRun.id} ${JSON.stringify(
      {
        image: isStandbyResume ? '(retained container)' : config.image,
        platform: config.platform,
        controlNetwork,
        taskNetwork: dockerNetwork,
        egressPolicy: config.egressPolicy,
        ports: namedPorts.map((port) => `${port.name}:${port.port}`),
      },
    )}`,
  );

  let containerId = '';

  const startContainer = async (diskLimit?: string): Promise<string> =>
    (
      await runDocker([
        'run',
        '-d',
        ...(autoRemoveContainer ? ['--rm'] : []),
        '--name',
        containerName,
        '--platform',
        config.platform,
        '--network',
        dockerNetwork,
        '--network-alias',
        containerName,
        ...buildDockerWorkerResourceArgs({ ...config, diskLimit }),
        ...buildDockerWorkerLabels({
          taskRunId: taskRun.id,
          autoRemove: autoRemoveContainer,
        }),
        ...(!controlNetwork
          ? ['--add-host', 'host.docker.internal:host-gateway']
          : []),
        ...portArgs,
        ...(usesDockerProjects
          ? ['--volume', `${taskWorkspaceVolumeName}:${DOCKER_WORKER_ROOT}`]
          : []),
        config.image,
        DOCKER_CONTAINER_READY_COMMAND,
        ...DOCKER_CONTAINER_READY_ARGS,
      ])
    ).trim();

  try {
    throwIfSpawnAborted();

    if (!isStandbyResume) {
      dockerNetwork = await prepareDockerTaskNetwork(
        {
          taskRunId: taskRun.id,
          controlNetwork,
          egressPolicy: config.egressPolicy,
          autoRemove: autoRemoveContainer,
        },
        runDocker,
      );
    }

    if (isStandbyResume) {
      // Retain ownership before `docker start`. If cancel aborts the start
      // call after Docker has begun starting the retained snapshot, catch must
      // still take the non-destructive resume path and never delete it.
      containerId = containerName;
      await runDocker(['start', containerName]);
      await restoreDockerStandbyNetworking(
        {
          containerName,
          taskNetwork: dockerNetwork,
          controlNetwork,
          egressPolicy: config.egressPolicy,
          image: config.image,
          platform: config.platform,
        },
        runDocker,
      );
    } else {
      if (usesDockerProjects) {
        await runDocker([
          'volume',
          'create',
          ...buildDockerWorkerLabels({
            taskRunId: taskRun.id,
            autoRemove: autoRemoveContainer,
          }),
          taskWorkspaceVolumeName,
        ]);
      }

      try {
        containerId = await startContainer(config.diskLimit);
      } catch (error) {
        if (
          !shouldRetryDockerWorkerWithoutDiskLimit({
            diskLimit: config.diskLimit,
            allowUnboundedDisk: config.allowUnboundedDisk,
            error,
          })
        ) {
          throw error;
        }

        console.warn(
          `[spawnDockerWorker] Docker storage driver cannot enforce writable-layer limit ${config.diskLimit}; DOCKER_WORKER_ALLOW_UNBOUNDED_DISK is enabled, so this task will continue without --storage-opt size.`,
        );
        await runDocker(['rm', '-f', containerName], { allowFailure: true });
        containerId = await startContainer();
      }

      await attachDockerEgressPolicy(
        {
          containerName,
          egressPolicy: config.egressPolicy,
          image: config.image,
          platform: config.platform,
          blockDockerGateway: Boolean(controlNetwork),
        },
        runDocker,
      );
      await runDocker([
        'cp',
        `${resolveFromWorkspaceRoot('.docker/sandbox')}/.`,
        `${containerName}:${DOCKER_WORKER_ROOT}/`,
      ]);
      await runDocker([
        'cp',
        config.localWorkerReleasePath!,
        `${containerName}:${DOCKER_WORKER_ARCHIVE_PATH}`,
      ]);
      // docker cp preserves host-side ownership on the copied tree, which on
      // macOS leaves /sandbox owned by the host uid instead of the image user
      // and makes install-worker.sh unable to create /sandbox/worker.
      const workerOwner = await resolveDockerWorkerOwnershipTarget(
        containerName,
        runDocker,
      );
      await runDocker([
        'exec',
        '-u',
        'root',
        containerName,
        'chown',
        '-R',
        workerOwner,
        DOCKER_WORKER_ROOT,
      ]);
      await runDocker([
        'exec',
        containerName,
        'bash',
        DOCKER_INSTALL_WORKER_SCRIPT,
      ]);

      if (usesDockerProjects) {
        await runDocker([
          'run',
          '-d',
          ...(autoRemoveContainer ? ['--rm'] : []),
          '--name',
          taskDaemonContainerName,
          '--platform',
          config.platform,
          '--network',
          `container:${containerName}`,
          '--privileged',
          '--env',
          'DOCKER_TLS_CERTDIR=',
          ...buildDockerTaskDaemonResourceArgs({
            ...config,
            memoryLimit: config.taskDaemonMemoryLimit,
          }),
          ...buildDockerWorkerLabels({
            taskRunId: taskRun.id,
            autoRemove: autoRemoveContainer,
          }),
          '--volume',
          `${taskWorkspaceVolumeName}:${DOCKER_WORKER_ROOT}`,
          DOCKER_TASK_DAEMON_IMAGE,
          '--host=tcp://0.0.0.0:2375',
          '--tls=false',
        ]);
      }
    }

    if (isStandbyResume && usesDockerProjects) {
      await resumeDockerTaskDaemon(taskDaemonContainerName, runDocker);
    }

    throwIfSpawnAborted();

    const portMap = controlNetwork
      ? new Map<number, string>()
      : await getPublishedPorts(containerName, namedPorts, runDocker);
    const sandboxServerUrl = buildDockerSandboxServerUrl({
      network: controlNetwork ? dockerNetwork : undefined,
      taskId: taskRun.taskId,
      publicAppUrl: process.env.R_PUBLIC_URL || process.env.R_APP_URL,
      previewProxyBaseUrl:
        resolvedPreviewRuntimeConfig.effective.previewProxyBaseUrl ?? undefined,
    });

    await updateTaskRunMachine({
      taskRun,
      vendor: 'docker',
      machineId: containerName,
      namedPorts,
      domainFn: (port) =>
        controlNetwork
          ? `http://${containerName}:${port}`
          : `http://127.0.0.1:${portMap.get(port) ?? String(port)}`,
      explicitPrimaryPortName: getPrimaryPortFromConfig(
        environmentConfig?.ports,
      )?.name,
      sandboxServerUrl,
      sourceSnapshotId: isStandbyResume ? containerName : null,
      authBypassValue,
      authBypassHeaderName,
    });

    await stampTaskRunMilestone({
      runId: taskRun.id,
      field: 'provisionReadyAt',
    });

    throwIfSpawnAborted();

    const workerTrpcUrl = resolveDockerWorkerTrpcUrl({
      trpcUrl: process.env.TRPC_URL ?? Env.TRPC_URL,
      controlNetwork,
    });
    const workerEnv = buildDockerWorkerEnv({
      authToken,
      sandboxExpiresAtMs: Date.now() + config.dockerTimeoutMs,
      deploymentSlug: config.deploymentSlug,
      environmentId: taskRun.payload.environmentId,
      image: config.image,
      extraEnv: {
        SANDBOX_TIMEOUT_MS: String(config.dockerTimeoutMs),
        TRPC_URL: workerTrpcUrl,
        // Mock-Slack parity: worker-side SlackNotifier calls (question blocks,
        // reactions) must reach the same mock harness the API uses.
        ...(process.env.SLACK_API_BASE_URL && {
          SLACK_API_BASE_URL: toContainerReachableUrl(
            process.env.SLACK_API_BASE_URL,
          ),
        }),
        R_APP_URL: toContainerReachableUrl(
          process.env.R_APP_URL ?? Env.R_APP_URL,
        ),
        // Legacy alias for pre-rename workers inside resumed snapshots; must
        // carry the same container-reachable override as R_APP_URL above.
        ROOMOTE_APP_URL: toContainerReachableUrl(
          process.env.R_APP_URL ?? Env.R_APP_URL,
        ),
        ...(resolvedPreviewRuntimeConfig.effective.previewProxyBaseUrl && {
          PREVIEW_PROXY_BASE_URL:
            resolvedPreviewRuntimeConfig.effective.previewProxyBaseUrl,
        }),
        ...(resolvedPreviewRuntimeConfig.effective.previewDomains && {
          PREVIEW_DOMAINS:
            resolvedPreviewRuntimeConfig.effective.previewDomains,
        }),
        ...(resolvedPreviewRuntimeConfig.effective.roomotePreviewDomain && {
          ROOMOTE_PREVIEW_DOMAIN:
            resolvedPreviewRuntimeConfig.effective.roomotePreviewDomain,
        }),
        ...(usesDockerProjects && {
          DOCKER_HOST: 'tcp://127.0.0.1:2375',
          DOCKER_TLS_CERTDIR: '',
        }),
      },
    });

    assertDockerWorkerLaunchEnv(workerEnv);

    const workerCommand = getDockerWorkerCommand(taskRun.payloadKind);
    // Inject via `docker exec -e` so the worker process gets AUTH_TOKEN /
    // TRPC_URL without baking secrets into `docker inspect` Config.Env.
    // Operators checking a later plain `docker exec` shell will not see these
    // keys — that is expected and does not mean spawn skipped injection.
    await runDocker([
      'exec',
      '-d',
      ...buildDockerWorkerExecEnvArgs(workerEnv),
      containerName,
      'bash',
      '-lc',
      `worker ${workerCommand} ${taskRun.id} > /proc/1/fd/1 2> /proc/1/fd/2`,
    ]);

    await assertDetachedWorkerStarted(containerName, taskRun.id, config.signal);

    console.log(
      `[spawnDockerWorker] Docker worker launched for task run #${taskRun.id} ${JSON.stringify(
        {
          containerName,
          containerId,
          trpcUrl: sanitizeDockerWorkerTrpcUrlForLog(workerTrpcUrl),
          envKeys: Object.keys(workerEnv).sort(),
        },
      )}`,
    );

    return { containerId: containerName };
  } catch (error) {
    const aborted = config.signal?.aborted || isAbortError(error);
    const cleanupMode = resolveDockerSpawnCleanupMode({
      isStandbyResume,
      aborted,
      appEnv: resolveAppEnv(process.env),
      hasContainerId: Boolean(containerId),
    });

    if (cleanupMode === 'stop-retained') {
      await docker(['stop', '--time', '10', containerName], {
        allowFailure: true,
      });
      // Nested Docker project daemons are started on standby resume. Stop the
      // privileged `<worker>-docker` daemon so it does not keep running after a
      // failed resume, but keep the container retained for later `docker start`
      // (resume never recreates the daemon).
      if (usesDockerProjects) {
        await docker(['stop', '--time', '10', taskDaemonContainerName], {
          allowFailure: true,
        });
      }
    } else if (cleanupMode === 'preserve-dev') {
      // Keep ordinary local spawn failures for debugging, but never retain a
      // canceled or timed-out partial provision (autoRemove is false).
      console.error(
        `[spawnDockerWorker] Preserving failed Docker worker container ${containerName} for local debugging`,
      );
    } else {
      await removeDockerSandboxResources({
        containerName,
        taskNetwork: dockerNetwork,
      });
      // updateTaskRunMachine may have already persisted routing for this
      // container before abort; terminal cancel leaves those fields in place.
      await clearTaskRunMachine(taskRun.id);
    }
    throw error;
  }
}

type DockerSpawnCleanupMode = 'stop-retained' | 'preserve-dev' | 'remove';

/**
 * Snapshot resume always stops and keeps the retained worker. Fresh spawn may
 * preserve ordinary development failures, but abort/timeout always tear down.
 */
export function resolveDockerSpawnCleanupMode(params: {
  isStandbyResume: boolean;
  aborted: boolean;
  appEnv: string;
  hasContainerId: boolean;
}): DockerSpawnCleanupMode {
  if (params.isStandbyResume) {
    return 'stop-retained';
  }

  if (
    shouldPreserveFailedDockerWorkerContainer({
      aborted: params.aborted,
      appEnv: params.appEnv,
      hasContainerId: params.hasContainerId,
    })
  ) {
    return 'preserve-dev';
  }

  return 'remove';
}

/**
 * Development preserves non-abort fresh-spawn failures for inspection. Cancel
 * and timeout must always tear down partial sandboxes because workers are not
 * auto-removed.
 */
export function shouldPreserveFailedDockerWorkerContainer(params: {
  aborted: boolean;
  appEnv: string;
  hasContainerId: boolean;
}): boolean {
  return (
    !params.aborted && params.appEnv === 'development' && params.hasContainerId
  );
}

export async function resumeDockerTaskDaemon(
  containerName: string,
  runDocker: typeof docker = docker,
): Promise<void> {
  await runDocker(['start', containerName], { allowFailure: true });
}

export function shouldRetryDockerWorkerWithoutDiskLimit(params: {
  diskLimit?: string;
  allowUnboundedDisk: boolean;
  error: unknown;
}): boolean {
  if (!params.diskLimit || !isUnsupportedDockerDiskLimitError(params.error)) {
    return false;
  }

  if (!params.allowUnboundedDisk) {
    throw new NonRetryableSpawnError(
      `Docker storage driver cannot enforce writable-layer limit ${params.diskLimit}. Refusing to start an unbounded task. Configure a quota-capable Docker data root or set DOCKER_WORKER_ALLOW_UNBOUNDED_DISK=true to explicitly accept the host disk-exhaustion risk.`,
    );
  }

  return true;
}

async function assertDetachedWorkerStarted(
  containerName: string,
  runId: number,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + DOCKER_WORKER_START_TIMEOUT_MS;
  let processList = '';
  const runDocker: DockerCommand = (args, options = {}) =>
    docker(args, { ...options, signal: signal ?? options.signal });

  while (Date.now() < deadline) {
    signal?.throwIfAborted();

    const containerState = await runDocker(
      ['inspect', containerName, '--format', '{{.State.Running}}'],
      // An auto-removed (`--rm`) container that exits early no longer exists,
      // so treat a failed inspect as "not running" instead of throwing raw.
      { allowFailure: true },
    );

    if (containerState.trim() !== 'true') {
      const logs = await runDocker(['logs', '--tail', '80', containerName], {
        allowFailure: true,
      });

      throw new DockerBootError(
        classifyWorkerBootLogs(logs, TaskRunErrorCode.DockerWorkerExitedEarly),
        [
          `Docker worker container exited before task run #${runId} started.`,
          'The sandbox container stopped during boot. Common causes include a missing worker image, a failed entrypoint, or the worker crashing on startup.',
          logs.trim() ? `Recent Docker logs:\n${logs.trim()}` : undefined,
        ]
          .filter(Boolean)
          .join('\n\n'),
      );
    }

    processList = await runDocker(
      ['exec', containerName, 'ps', '-eo', 'args'],
      {
        allowFailure: true,
      },
    );

    if (processListIncludesDockerWorkerRun(processList, runId)) {
      return;
    }

    if (await hasTaskRunStarted(runId)) {
      return;
    }

    await sleep(DOCKER_WORKER_START_POLL_MS, signal);
  }

  signal?.throwIfAborted();

  const logs = await runDocker(['logs', '--tail', '80', containerName], {
    allowFailure: true,
  });

  const timeoutSeconds = Math.round(DOCKER_WORKER_START_TIMEOUT_MS / 1000);

  throw new DockerBootError(
    classifyWorkerBootLogs(logs, TaskRunErrorCode.DockerWorkerStartTimeout),
    [
      `Docker worker for task run #${runId} did not start within ${timeoutSeconds}s.`,
      'The container stayed running, but the Roomote worker process never appeared. Check that the local worker image and release archive are available, and inspect container logs for fetch/start failures.',
      processList.trim()
        ? `Docker process list:\n${processList.trim()}`
        : 'Docker process list was empty.',
      logs.trim() ? `Recent Docker logs:\n${logs.trim()}` : undefined,
    ]
      .filter(Boolean)
      .join('\n\n'),
  );
}

/**
 * A worker that dies (or never appears) because it cannot reach the Roomote
 * API logs a `fetch failed` job error — a distinct, actionable category
 * (networking from inside Docker) rather than a generic start failure.
 */
function classifyWorkerBootLogs(
  logs: string,
  fallback: TaskRunErrorCode,
): TaskRunErrorCode {
  return /failed:\s*fetch failed/i.test(logs)
    ? TaskRunErrorCode.DockerWorkerFetchFailed
    : fallback;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(
        signal.reason instanceof Error ? signal.reason : createAbortError(),
      );
      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      reject(
        signal?.reason instanceof Error ? signal.reason : createAbortError(),
      );
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function createAbortError(): Error {
  const error = new Error('This operation was aborted');
  error.name = 'AbortError';
  return error;
}

async function hasTaskRunStarted(runId: number): Promise<boolean> {
  const taskRun = await db.query.taskRuns.findFirst({
    where: eq(taskRuns.id, runId),
    columns: {
      startedAt: true,
    },
  });

  return Boolean(taskRun?.startedAt);
}

export function buildDockerSandboxServerUrl(params: {
  network?: string;
  taskId?: string | null;
  publicAppUrl?: string;
  previewProxyBaseUrl?: string;
}): string | undefined {
  if (!params.taskId) {
    return undefined;
  }

  if (params.network && params.previewProxyBaseUrl) {
    return buildPreviewProxyUrl(
      params.taskId,
      portNameToSlug(SANDBOX_SERVER_NAMED_PORT.name),
      params.previewProxyBaseUrl,
    );
  }

  if (!params.network && params.publicAppUrl) {
    return `${params.publicAppUrl.replace(/\/+$/, '')}/_roomote-sandbox/${params.taskId}`;
  }

  return undefined;
}

async function getPublishedPorts(
  containerName: string,
  namedPorts: NamedPort[],
  runDocker: DockerCommand = docker,
): Promise<Map<number, string>> {
  const ports = new Map<number, string>();

  for (const { port } of namedPorts) {
    const output = await runDocker(['port', containerName, `${port}/tcp`], {
      allowFailure: true,
    });
    const match = output.match(/(?:127\.0\.0\.1|0\.0\.0\.0|\[::\]):(\d+)/);

    if (match?.[1]) {
      ports.set(port, match[1]);
    }
  }

  return ports;
}

async function resolveDockerWorkerOwnershipTarget(
  containerName: string,
  runDocker: DockerCommand = docker,
): Promise<string> {
  if (await hasRoomoteUserAndGroup(containerName, runDocker)) {
    return 'roomote:roomote';
  }

  const imageUser = (
    await runDocker(['inspect', containerName, '--format', '{{.Config.User}}'])
  ).trim();

  if (!imageUser) {
    return 'root:root';
  }

  const passwdEntry =
    imageUser.includes(':') || /^\d+$/.test(imageUser)
      ? ''
      : (
          await runDocker(
            [
              'exec',
              '-u',
              'root',
              containerName,
              'getent',
              'passwd',
              imageUser,
            ],
            { allowFailure: true },
          )
        ).trim();

  const groupEntry = passwdEntry
    ? (
        await runDocker(
          [
            'exec',
            '-u',
            'root',
            containerName,
            'getent',
            'group',
            passwdEntry.split(':')[3] ?? '',
          ],
          { allowFailure: true },
        )
      ).trim()
    : '';

  return resolveDockerWorkerOwnershipTargetFromLookup({
    imageUser,
    passwdEntry,
    groupEntry,
  });
}

async function hasRoomoteUserAndGroup(
  containerName: string,
  runDocker: DockerCommand = docker,
): Promise<boolean> {
  const passwdEntry = (
    await runDocker(
      ['exec', '-u', 'root', containerName, 'getent', 'passwd', 'roomote'],
      { allowFailure: true },
    )
  ).trim();
  const groupEntry = (
    await runDocker(
      ['exec', '-u', 'root', containerName, 'getent', 'group', 'roomote'],
      { allowFailure: true },
    )
  ).trim();

  return Boolean(passwdEntry && groupEntry);
}

export function resolveDockerWorkerOwnershipTargetFromLookup({
  imageUser,
  passwdEntry = '',
  groupEntry = '',
}: {
  imageUser: string;
  passwdEntry?: string;
  groupEntry?: string;
}): string {
  const trimmedImageUser = imageUser.trim();

  if (!trimmedImageUser) {
    return 'root:root';
  }

  if (trimmedImageUser.includes(':')) {
    return trimmedImageUser;
  }

  if (/^\d+$/.test(trimmedImageUser)) {
    return `${trimmedImageUser}:${trimmedImageUser}`;
  }

  const gid = passwdEntry.trim().split(':')[3];

  if (!gid) {
    throw new Error(
      `Docker worker image user "${trimmedImageUser}" does not exist in /etc/passwd`,
    );
  }

  const groupName = groupEntry.trim().split(':')[0] || gid;

  return `${trimmedImageUser}:${groupName}`;
}

/** Retention owns cleanup, so Docker must not remove a resumable container. */
export function shouldAutoRemoveDockerWorkerContainer(appEnv: string): boolean {
  void appEnv;
  return false;
}

function getDockerSourceRunId(containerName: string): number {
  const match = /^roomote-worker-(\d+)$/.exec(containerName);
  const runId = Number(match?.[1]);
  if (!Number.isInteger(runId)) {
    throw new NonRetryableSpawnError(
      `Invalid Docker standby handle: ${containerName}`,
    );
  }
  return runId;
}

export function getDockerWorkerCommand(
  payloadKind: TaskPayloadKind,
): 'resume' | 'run' {
  return payloadKind === TaskPayloadKind.SnapshotResume ? 'resume' : 'run';
}

/**
 * Docker Compose self-host/prod attaches the `api` service to each task
 * network. When a control network is configured, egress policy blocks packets
 * destined for the Docker bridge gateway so sandboxes cannot hairpin through
 * the public edge.
 * Workers must call the in-network API alias directly (no `/_roomote-api`
 * prefix — that path only exists on the public reverse proxy).
 */
export const DOCKER_CONTROL_PLANE_TRPC_URL = 'http://api:3001';

export function resolveDockerWorkerTrpcUrl(params: {
  trpcUrl: string | undefined;
  controlNetwork?: string;
}): string {
  // Control-plane isolation only trusts the `api` service on the task
  // network at the app origin/root. Public reverse-proxy path prefixes such
  // as `/_roomote-api` must not be preserved even when hostname is already
  // `api`.
  if (params.controlNetwork?.trim()) {
    return DOCKER_CONTROL_PLANE_TRPC_URL;
  }

  return toContainerReachableUrl(params.trpcUrl);
}

/**
 * Log-safe view of the worker TRPC URL: drops userinfo credentials and
 * query/hash so operator logs never capture embedded secrets while still
 * showing host + path for spawn diagnosis.
 */
export function sanitizeDockerWorkerTrpcUrlForLog(trpcUrl: string): string {
  try {
    const url = new URL(trpcUrl);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return trimTrailingSlash(url.toString());
  } catch {
    return '[invalid-trpc-url]';
  }
}

const REQUIRED_DOCKER_WORKER_LAUNCH_ENV_KEYS = [
  'AUTH_TOKEN',
  'TRPC_URL',
  'R_APP_URL',
] as const;

export function assertDockerWorkerLaunchEnv(
  workerEnv: Record<string, string>,
): void {
  const missing = REQUIRED_DOCKER_WORKER_LAUNCH_ENV_KEYS.filter(
    (key) => !workerEnv[key]?.trim(),
  );

  if (missing.length > 0) {
    throw new Error(
      `Docker worker launch env missing required value(s): ${missing.join(', ')}`,
    );
  }
}

export function buildDockerWorkerExecEnvArgs(
  workerEnv: Record<string, string>,
): string[] {
  return Object.entries(workerEnv).flatMap(([key, value]) => [
    '-e',
    `${key}=${value}`,
  ]);
}

export function toContainerReachableUrl(value: string | undefined): string {
  if (!value) {
    return '';
  }

  try {
    const url = new URL(value);

    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
      url.hostname = 'host.docker.internal';
      return trimTrailingSlash(url.toString());
    }
  } catch {
    return value;
  }

  return trimTrailingSlash(value);
}

function trimTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}
