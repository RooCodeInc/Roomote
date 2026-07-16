import { existsSync } from 'node:fs';

import {
  buildPreviewProxyUrl,
  TaskPayloadKind,
  NonRetryableSpawnError,
  getPrimaryPortFromConfig,
  portNameToSlug,
  SANDBOX_SERVER_NAMED_PORT,
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
import { isInferenceGatewayEnabledForWorkerEnv } from './inference-gateway-flag';

import {
  getNamedPortsForTaskRun,
  shouldEnableAuthBypassForTaskRun,
  updateTaskRunMachine,
} from '../utils';
import { resolveFromWorkspaceRoot } from '../repo-paths';
import {
  attachDockerEgressPolicy,
  buildDockerTaskDaemonResourceArgs,
  buildDockerWorkerLabels,
  buildDockerWorkerResourceArgs,
  docker,
  getDockerTaskNetworkName,
  getDockerTaskDaemonContainerName,
  getDockerTaskWorkspaceVolumeName,
  getDockerWorkerContainerName,
  isUnsupportedDockerDiskLimitError,
  prepareDockerTaskNetwork,
  processListIncludesDockerWorkerRun,
  removeDockerSandboxResources,
  restoreDockerStandbyNetworking,
  type DockerWorkerEgressPolicy,
} from './docker-sandbox-security';
import { taskNeedsNestedDocker } from './task-sandbox-resources';

const DOCKER_CONTAINER_READY_COMMAND = 'sleep';
const DOCKER_CONTAINER_READY_ARGS = ['infinity'];
const DOCKER_WORKER_ARCHIVE_PATH = '/sandbox/worker.tar.gz';
const DOCKER_WORKER_ROOT = '/sandbox';
const DOCKER_INSTALL_WORKER_SCRIPT = `${DOCKER_WORKER_ROOT}/install-worker.sh`;
const DOCKER_WORKER_START_TIMEOUT_MS = 15_000;
const DOCKER_WORKER_START_POLL_MS = 500;
const DOCKER_TASK_DAEMON_IMAGE = 'docker:28-dind';

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
    throw new Error(
      'Docker provider requires a local worker release archive. TaskRun pnpm dev without --use-release.',
    );
  }

  if (
    !isStandbyResume &&
    config.localWorkerReleasePath &&
    !existsSync(config.localWorkerReleasePath)
  ) {
    throw new Error(
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
  const dockerNetwork = isStandbyResume
    ? getDockerTaskNetworkName(sourceRunId)
    : await prepareDockerTaskNetwork({
        taskRunId: taskRun.id,
        controlNetwork,
        egressPolicy: config.egressPolicy,
        autoRemove: autoRemoveContainer,
      });

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
      await docker([
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
    if (isStandbyResume) {
      await docker(['start', containerName]);
      containerId = containerName;
      await restoreDockerStandbyNetworking({
        containerName,
        taskNetwork: dockerNetwork,
        controlNetwork,
        egressPolicy: config.egressPolicy,
        image: config.image,
        platform: config.platform,
      });
    } else {
      if (usesDockerProjects) {
        await docker([
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
        await docker(['rm', '-f', containerName], { allowFailure: true });
        containerId = await startContainer();
      }

      await attachDockerEgressPolicy({
        containerName,
        egressPolicy: config.egressPolicy,
        image: config.image,
        platform: config.platform,
        blockDockerGateway: Boolean(controlNetwork),
      });
      await docker([
        'cp',
        `${resolveFromWorkspaceRoot('.docker/sandbox')}/.`,
        `${containerName}:${DOCKER_WORKER_ROOT}/`,
      ]);
      await docker([
        'cp',
        config.localWorkerReleasePath!,
        `${containerName}:${DOCKER_WORKER_ARCHIVE_PATH}`,
      ]);
      // docker cp preserves host-side ownership on the copied tree, which on
      // macOS leaves /sandbox owned by the host uid instead of the image user
      // and makes install-worker.sh unable to create /sandbox/worker.
      const workerOwner =
        await resolveDockerWorkerOwnershipTarget(containerName);
      await docker([
        'exec',
        '-u',
        'root',
        containerName,
        'chown',
        '-R',
        workerOwner,
        DOCKER_WORKER_ROOT,
      ]);
      await docker([
        'exec',
        containerName,
        'bash',
        DOCKER_INSTALL_WORKER_SCRIPT,
      ]);

      if (usesDockerProjects) {
        await docker([
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
      await resumeDockerTaskDaemon(taskDaemonContainerName);
    }

    const portMap = controlNetwork
      ? new Map<number, string>()
      : await getPublishedPorts(containerName, namedPorts);
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

    const workerEnv = buildDockerWorkerEnv({
      authToken,
      inferenceGatewayEnabled: await isInferenceGatewayEnabledForWorkerEnv(),
      sandboxExpiresAtMs: Date.now() + config.dockerTimeoutMs,
      deploymentSlug: config.deploymentSlug,
      environmentId: taskRun.payload.environmentId,
      image: config.image,
      extraEnv: {
        SANDBOX_TIMEOUT_MS: String(config.dockerTimeoutMs),
        TRPC_URL: toContainerReachableUrl(process.env.TRPC_URL ?? Env.TRPC_URL),
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

    const workerCommand = getDockerWorkerCommand(taskRun.payloadKind);
    await docker([
      'exec',
      '-d',
      ...Object.entries(workerEnv).flatMap(([key, value]) => [
        '-e',
        `${key}=${value}`,
      ]),
      containerName,
      'bash',
      '-lc',
      `worker ${workerCommand} ${taskRun.id} > /proc/1/fd/1 2> /proc/1/fd/2`,
    ]);

    await assertDetachedWorkerStarted(containerName, taskRun.id);

    console.log(
      `[spawnDockerWorker] Docker worker launched for task run #${taskRun.id} ${JSON.stringify(
        { containerName, containerId },
      )}`,
    );

    return { containerId: containerName };
  } catch (error) {
    if (isStandbyResume && containerId) {
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
    } else if (resolveAppEnv(process.env) === 'development' && containerId) {
      console.error(
        `[spawnDockerWorker] Preserving failed Docker worker container ${containerName} for local debugging`,
      );
    } else {
      await removeDockerSandboxResources({
        containerName,
        taskNetwork: dockerNetwork,
      });
    }
    throw error;
  }
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
): Promise<void> {
  const deadline = Date.now() + DOCKER_WORKER_START_TIMEOUT_MS;
  let processList = '';

  while (Date.now() < deadline) {
    const containerState = await docker(
      ['inspect', containerName, '--format', '{{.State.Running}}'],
      // An auto-removed (`--rm`) container that exits early no longer exists,
      // so treat a failed inspect as "not running" instead of throwing raw.
      { allowFailure: true },
    );

    if (containerState.trim() !== 'true') {
      const logs = await docker(['logs', '--tail', '80', containerName], {
        allowFailure: true,
      });

      throw new Error(
        [
          `Docker worker container exited before task run #${runId} started.`,
          logs.trim() ? `Recent Docker logs:\n${logs.trim()}` : undefined,
        ]
          .filter(Boolean)
          .join('\n\n'),
      );
    }

    processList = await docker(['exec', containerName, 'ps', '-eo', 'args'], {
      allowFailure: true,
    });

    if (processListIncludesDockerWorkerRun(processList, runId)) {
      return;
    }

    if (await hasTaskRunStarted(runId)) {
      return;
    }

    await new Promise((resolve) =>
      setTimeout(resolve, DOCKER_WORKER_START_POLL_MS),
    );
  }

  const logs = await docker(['logs', '--tail', '80', containerName], {
    allowFailure: true,
  });

  throw new Error(
    [
      `Docker worker command for task run #${runId} was not observed during startup.`,
      processList.trim()
        ? `Docker process list:\n${processList.trim()}`
        : 'Docker process list was empty.',
      logs.trim() ? `Recent Docker logs:\n${logs.trim()}` : undefined,
    ]
      .filter(Boolean)
      .join('\n\n'),
  );
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
): Promise<Map<number, string>> {
  const ports = new Map<number, string>();

  for (const { port } of namedPorts) {
    const output = await docker(['port', containerName, `${port}/tcp`], {
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
): Promise<string> {
  if (await hasRoomoteUserAndGroup(containerName)) {
    return 'roomote:roomote';
  }

  const imageUser = (
    await docker(['inspect', containerName, '--format', '{{.Config.User}}'])
  ).trim();

  if (!imageUser) {
    return 'root:root';
  }

  const passwdEntry =
    imageUser.includes(':') || /^\d+$/.test(imageUser)
      ? ''
      : (
          await docker(
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
        await docker(
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

async function hasRoomoteUserAndGroup(containerName: string): Promise<boolean> {
  const passwdEntry = (
    await docker(
      ['exec', '-u', 'root', containerName, 'getent', 'passwd', 'roomote'],
      { allowFailure: true },
    )
  ).trim();
  const groupEntry = (
    await docker(
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
