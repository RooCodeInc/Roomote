import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

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

import {
  getNamedPortsForTaskRun,
  shouldEnableAuthBypassForTaskRun,
  updateTaskRunMachine,
} from '../utils';
import { resolveFromWorkspaceRoot } from '../repo-paths';

const execFileAsync = promisify(execFile);

const DOCKER_CONTAINER_READY_COMMAND = 'sleep';
const DOCKER_CONTAINER_READY_ARGS = ['infinity'];
const DOCKER_WORKER_ARCHIVE_PATH = '/sandbox/worker.tar.gz';
const DOCKER_WORKER_ROOT = '/sandbox';
const DOCKER_INSTALL_WORKER_SCRIPT = `${DOCKER_WORKER_ROOT}/install-worker.sh`;
const DOCKER_WORKER_START_TIMEOUT_MS = 15_000;
const DOCKER_WORKER_START_POLL_MS = 500;

export async function spawnDockerWorker(
  taskRun: TaskRun,
  authToken: string,
  config: {
    image: string;
    platform: string;
    network?: string;
    dockerTimeoutMs: number;
    localWorkerReleasePath?: string;
    deploymentSlug?: string;
  },
): Promise<{ containerId: string }> {
  if (
    taskRun.payloadKind === TaskPayloadKind.SnapshotEnvironment ||
    taskRun.payloadKind === TaskPayloadKind.SnapshotResume
  ) {
    throw new NonRetryableSpawnError(
      `Docker provider does not support ${taskRun.payloadKind} task run kinds`,
    );
  }

  if (!config.localWorkerReleasePath) {
    throw new Error(
      'Docker provider requires a local worker release archive. TaskRun pnpm dev without --use-release.',
    );
  }

  if (!existsSync(config.localWorkerReleasePath)) {
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

  const containerName = `roomote-worker-${taskRun.id}`;
  const dockerNetwork = config.network?.trim();
  const networkArgs = dockerNetwork
    ? ['--network', dockerNetwork, '--network-alias', containerName]
    : [];
  const portArgs = dockerNetwork
    ? []
    : namedPorts.flatMap(({ port }) => ['-p', `127.0.0.1::${port}`]);

  await docker(['rm', '-f', containerName], { allowFailure: true });

  // Auto-remove the container when its worker process exits so the cloned repo
  // and the worker's short-lived token files do not linger in a stopped
  // container. Development keeps containers for post-mortem debugging.
  const autoRemoveContainer = shouldAutoRemoveDockerWorkerContainer(
    resolveAppEnv(process.env),
  );

  console.log(
    `[spawnDockerWorker] Starting Docker worker container for task run #${taskRun.id} ${JSON.stringify(
      {
        image: config.image,
        platform: config.platform,
        network: dockerNetwork,
        ports: namedPorts.map((port) => `${port.name}:${port.port}`),
      },
    )}`,
  );

  const containerId = (
    await docker([
      'run',
      '-d',
      ...(autoRemoveContainer ? ['--rm'] : []),
      '--name',
      containerName,
      '--platform',
      config.platform,
      '--add-host',
      'host.docker.internal:host-gateway',
      ...networkArgs,
      ...portArgs,
      config.image,
      DOCKER_CONTAINER_READY_COMMAND,
      ...DOCKER_CONTAINER_READY_ARGS,
    ])
  ).trim();

  try {
    await docker([
      'cp',
      `${resolveFromWorkspaceRoot('.docker/sandbox')}/.`,
      `${containerName}:${DOCKER_WORKER_ROOT}/`,
    ]);
    await docker([
      'cp',
      config.localWorkerReleasePath,
      `${containerName}:${DOCKER_WORKER_ARCHIVE_PATH}`,
    ]);
    // docker cp preserves host-side ownership on the copied tree, which on
    // macOS leaves /sandbox owned by the host uid instead of the image user
    // and makes install-worker.sh unable to create /sandbox/worker.
    const workerOwner = await resolveDockerWorkerOwnershipTarget(containerName);
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
    await docker(['exec', containerName, 'bash', DOCKER_INSTALL_WORKER_SCRIPT]);

    const portMap = dockerNetwork
      ? new Map<number, string>()
      : await getPublishedPorts(containerName, namedPorts);
    const sandboxServerUrl = buildDockerSandboxServerUrl({
      network: dockerNetwork,
      taskId: taskRun.taskId,
      previewProxyBaseUrl:
        resolvedPreviewRuntimeConfig.effective.previewProxyBaseUrl ?? undefined,
    });

    await updateTaskRunMachine({
      taskRun,
      vendor: 'docker',
      machineId: containerName,
      namedPorts,
      domainFn: (port) =>
        dockerNetwork
          ? `http://${containerName}:${port}`
          : `http://127.0.0.1:${portMap.get(port) ?? String(port)}`,
      explicitPrimaryPortName: getPrimaryPortFromConfig(
        environmentConfig?.ports,
      )?.name,
      sandboxServerUrl,
      sourceSnapshotId: null,
      authBypassValue,
      authBypassHeaderName,
    });

    await stampTaskRunMilestone({
      runId: taskRun.id,
      field: 'provisionReadyAt',
    });

    const workerEnv = buildDockerWorkerEnv({
      authToken,
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
      },
    });

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
      [
        `worker run ${taskRun.id} > /proc/1/fd/1 2> /proc/1/fd/2`,
        'status=$?',
        'kill 1',
        'exit "$status"',
      ].join('; '),
    ]);

    await assertDetachedWorkerStarted(containerName, taskRun.id);

    console.log(
      `[spawnDockerWorker] Docker worker launched for task run #${taskRun.id} ${JSON.stringify(
        { containerName, containerId },
      )}`,
    );

    return { containerId: containerName };
  } catch (error) {
    if (resolveAppEnv(process.env) === 'development') {
      console.error(
        `[spawnDockerWorker] Preserving failed Docker worker container ${containerName} for local debugging`,
      );
    } else {
      await docker(['rm', '-f', containerName], { allowFailure: true });
    }
    throw error;
  }
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

export function processListIncludesDockerWorkerRun(
  processList: string,
  runId: number,
): boolean {
  const escapedRunId = String(runId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  return processList
    .split('\n')
    .some((line) =>
      [
        new RegExp(`(?:^|\\s)worker\\s+run\\s+${escapedRunId}(?:\\s|$)`),
        new RegExp(
          `(?:^|[\\s/])worker\\.js\\s+run\\s+${escapedRunId}(?:\\s|$)`,
        ),
      ].some((pattern) => pattern.test(line)),
    );
}

export function buildDockerSandboxServerUrl(params: {
  network?: string;
  taskId?: string | null;
  previewProxyBaseUrl?: string;
}): string | undefined {
  if (!params.network || !params.taskId || !params.previewProxyBaseUrl) {
    return undefined;
  }

  return buildPreviewProxyUrl(
    params.taskId,
    portNameToSlug(SANDBOX_SERVER_NAMED_PORT.name),
    params.previewProxyBaseUrl,
  );
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

async function docker(
  args: string[],
  options: { allowFailure?: boolean } = {},
): Promise<string> {
  try {
    const { stdout } = await execFileAsync('docker', args, {
      cwd: resolveFromWorkspaceRoot('.'),
      maxBuffer: 10 * 1024 * 1024,
    });

    return stdout;
  } catch (error) {
    if (options.allowFailure) {
      return '';
    }

    throw error;
  }
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

/**
 * Whether a Docker worker container should be started with `--rm` so it is
 * removed once its worker exits. Development preserves stopped containers for
 * debugging; every other environment reaps them to avoid accumulating stopped
 * containers that still hold the cloned repo and the worker's token files.
 */
export function shouldAutoRemoveDockerWorkerContainer(appEnv: string): boolean {
  return appEnv !== 'development';
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
