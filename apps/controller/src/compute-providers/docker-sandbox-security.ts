import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { resolveFromWorkspaceRoot } from '../repo-paths';

const execFileAsync = promisify(execFile);

const MANAGED_NETWORK_LABEL = 'dev.roomote.sandbox.managed';
const EXPECTED_CONTAINER_LABEL = 'dev.roomote.sandbox.container';
const TASK_RUN_ID_LABEL = 'dev.roomote.task-run-id';
const AUTO_REMOVE_LABEL = 'dev.roomote.sandbox.auto-remove';
const CREATED_AT_MS_LABEL = 'dev.roomote.sandbox.created-at-ms';
const TASK_NETWORK_PREFIX = 'roomote-task-';
const WORKER_CONTAINER_PREFIX = 'roomote-worker-';
const STALE_PROVISIONING_TIMEOUT_MS = 15 * 60 * 1_000;

const TRUSTED_COMPOSE_SERVICES = new Set(['api', 'preview-proxy']);
const REQUIRED_TRUSTED_COMPOSE_SERVICES = ['api'] as const;

type DockerNetworkInspect = {
  Id?: string;
  Name?: string;
  Labels?: Record<string, string> | null;
  Containers?: Record<
    string,
    {
      Name?: string;
    }
  > | null;
};

type DockerContainerInspect = {
  Config?: {
    Labels?: Record<string, string> | null;
  };
  NetworkSettings?: {
    Networks?: Record<
      string,
      {
        NetworkID?: string;
        Aliases?: Array<string | null> | null;
      }
    > | null;
  };
  State?: {
    Running?: boolean;
  };
};

export type DockerCommand = (
  args: string[],
  options?: { allowFailure?: boolean },
) => Promise<string>;

export type DockerWorkerEgressPolicy = 'internet' | 'none';

type DockerWorkerResourceLimits = {
  cpuLimit: number;
  memoryLimit: string;
  pidsLimit: number;
  diskLimit?: string;
  logMaxSize: string;
  logMaxFiles: number;
};

const BLOCKED_METADATA_ROUTES = [
  '100.64.0.0/10',
  '169.254.0.0/16',
  '192.0.0.0/24',
] as const;

const BLOCKED_PRIVATE_ROUTES = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
] as const;

export async function docker(
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

export function getDockerTaskNetworkName(taskRunId: number): string {
  return `${TASK_NETWORK_PREFIX}${taskRunId}`;
}

export function getDockerWorkerContainerName(taskRunId: number): string {
  return `${WORKER_CONTAINER_PREFIX}${taskRunId}`;
}

export function buildDockerWorkerLabels(params: {
  taskRunId: number;
  autoRemove: boolean;
  createdAtMs?: number;
}): string[] {
  return [
    '--label',
    `${MANAGED_NETWORK_LABEL}=true`,
    '--label',
    `${TASK_RUN_ID_LABEL}=${params.taskRunId}`,
    '--label',
    `${AUTO_REMOVE_LABEL}=${String(params.autoRemove)}`,
    '--label',
    `${CREATED_AT_MS_LABEL}=${params.createdAtMs ?? Date.now()}`,
  ];
}

export function buildDockerWorkerResourceArgs(
  limits: DockerWorkerResourceLimits,
): string[] {
  return [
    '--cpus',
    String(limits.cpuLimit),
    '--memory',
    limits.memoryLimit,
    '--memory-swap',
    limits.memoryLimit,
    '--pids-limit',
    String(limits.pidsLimit),
    ...(limits.diskLimit ? ['--storage-opt', `size=${limits.diskLimit}`] : []),
    '--log-driver',
    'json-file',
    '--log-opt',
    `max-size=${limits.logMaxSize}`,
    '--log-opt',
    `max-file=${limits.logMaxFiles}`,
    '--cap-drop',
    'NET_ADMIN',
    '--cap-drop',
    'NET_RAW',
  ];
}

export function isUnsupportedDockerDiskLimitError(error: unknown): boolean {
  const output = getDockerErrorOutput(error);

  return [
    /storage-opt.*supported only/i,
    /storage-opt.*not supported/i,
    /unknown.*storage.*(?:option|opt)/i,
    /storage (?:option|opt).*size.*not supported/i,
    /storage driver.*does not support.*(?:size|quota|limit)/i,
    /filesystem.*does not support.*quota/i,
  ].some((pattern) => pattern.test(output));
}

export function processListIncludesDockerWorkerRun(
  processList: string,
  taskRunId: number,
): boolean {
  if (!Number.isInteger(taskRunId)) {
    return false;
  }

  const escapedTaskRunId = String(taskRunId).replace(
    /[.*+?^${}()|[\]\\]/g,
    '\\$&',
  );

  return processList
    .split('\n')
    .some((line) =>
      [
        new RegExp(`(?:^|\\s)worker\\s+run\\s+${escapedTaskRunId}(?:\\s|$)`),
        new RegExp(
          `(?:^|[\\s/])worker\\.js\\s+run\\s+${escapedTaskRunId}(?:\\s|$)`,
        ),
      ].some((pattern) => pattern.test(line)),
    );
}

export async function prepareDockerTaskNetwork(
  params: {
    taskRunId: number;
    controlNetwork?: string;
    egressPolicy: DockerWorkerEgressPolicy;
    autoRemove: boolean;
    createdAtMs?: number;
  },
  runDocker: DockerCommand = docker,
): Promise<string> {
  const taskNetwork = getDockerTaskNetworkName(params.taskRunId);
  const containerName = getDockerWorkerContainerName(params.taskRunId);

  await removeDockerSandboxResources({ containerName, taskNetwork }, runDocker);

  await runDocker([
    'network',
    'create',
    '--driver',
    'bridge',
    '--label',
    `${MANAGED_NETWORK_LABEL}=true`,
    '--label',
    `${EXPECTED_CONTAINER_LABEL}=${containerName}`,
    '--label',
    `${TASK_RUN_ID_LABEL}=${params.taskRunId}`,
    '--label',
    `${AUTO_REMOVE_LABEL}=${String(params.autoRemove)}`,
    '--label',
    `${CREATED_AT_MS_LABEL}=${params.createdAtMs ?? Date.now()}`,
    ...(params.egressPolicy === 'none' ? ['--internal'] : []),
    taskNetwork,
  ]);

  try {
    if (params.controlNetwork) {
      await connectTrustedControlPlaneServices(
        params.controlNetwork,
        taskNetwork,
        runDocker,
      );
    }
  } catch (error) {
    await removeDockerTaskNetwork(taskNetwork, runDocker);
    throw error;
  }

  return taskNetwork;
}

export async function attachDockerEgressPolicy(
  params: {
    containerName: string;
    egressPolicy: DockerWorkerEgressPolicy;
    image: string;
    platform: string;
    blockDockerGateway: boolean;
  },
  runDocker: DockerCommand = docker,
): Promise<void> {
  if (params.egressPolicy === 'none') {
    return;
  }

  const helperContainerName = getEgressPolicyHelperContainerName(
    params.containerName,
  );
  await runDocker(['rm', '-f', helperContainerName], { allowFailure: true });
  await runDocker([
    'run',
    '--rm',
    '--name',
    helperContainerName,
    '--platform',
    params.platform,
    '--network',
    `container:${params.containerName}`,
    '--user',
    'root',
    '--cap-drop',
    'ALL',
    '--cap-add',
    'NET_ADMIN',
    '--entrypoint',
    '/bin/sh',
    params.image,
    '-c',
    // `replace` keeps the script idempotent when a helper is re-run against a
    // network namespace that already holds some of the routes.
    [
      ...BLOCKED_METADATA_ROUTES.map(
        (route) => `ip route replace blackhole ${route}`,
      ),
      ...(params.blockDockerGateway
        ? [
            ...BLOCKED_PRIVATE_ROUTES.map(
              (route) => `ip route replace blackhole ${route}`,
            ),
            `gateway="$(ip route show default | awk 'NR == 1 { print $3 }')"`,
            'if [ -n "$gateway" ]; then ip route replace blackhole "$gateway/32"; fi',
          ]
        : []),
    ].join(' && '),
  ]);
}

export async function removeDockerSandboxResources(
  params: { containerName: string; taskNetwork: string },
  runDocker: DockerCommand = docker,
): Promise<void> {
  await runDocker(
    ['rm', '-f', getEgressPolicyHelperContainerName(params.containerName)],
    { allowFailure: true },
  );
  await runDocker(['rm', '-f', params.containerName], { allowFailure: true });
  await removeDockerTaskNetwork(params.taskNetwork, runDocker);
}

export async function cleanupStaleDockerSandboxes(
  options: { nowMs?: number; controlNetwork?: string } = {},
  runDocker: DockerCommand = docker,
): Promise<void> {
  const output = await runDocker(
    [
      'network',
      'ls',
      '--filter',
      `label=${MANAGED_NETWORK_LABEL}=true`,
      '--format',
      '{{.Name}}',
    ],
    { allowFailure: true },
  );
  const nowMs = options.nowMs ?? Date.now();

  for (const taskNetwork of output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith(TASK_NETWORK_PREFIX))) {
    try {
      await reconcileTaskNetwork(
        taskNetwork,
        options.controlNetwork,
        nowMs,
        runDocker,
      );
    } catch (error) {
      // One unreconcilable network must not stop the sweep: skip it and let
      // the next cycle retry. Nothing is removed for a network that throws.
      console.error(
        `[cleanupStaleDockerSandboxes] Skipping ${taskNetwork} this cycle: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

async function reconcileTaskNetwork(
  taskNetwork: string,
  controlNetwork: string | undefined,
  nowMs: number,
  runDocker: DockerCommand,
): Promise<void> {
  const network = await inspectNetwork(taskNetwork, runDocker);
  const labels = network?.Labels ?? {};
  const containerName = labels[EXPECTED_CONTAINER_LABEL];
  const createdAtMs = Number(labels[CREATED_AT_MS_LABEL]);
  const isPastProvisioningTimeout =
    !Number.isFinite(createdAtMs) ||
    nowMs - createdAtMs >= STALE_PROVISIONING_TIMEOUT_MS;

  if (!containerName) {
    await removeDockerTaskNetwork(taskNetwork, runDocker);
    return;
  }

  const container = await inspectContainer(containerName, runDocker);

  if (!container) {
    // A concurrent spawn creates and wires the network immediately before
    // creating the worker container. Do not let the periodic reaper race
    // that valid provisioning window.
    if (isPastProvisioningTimeout) {
      await removeDockerTaskNetwork(taskNetwork, runDocker);
    }
    return;
  }

  if (!container.State?.Running) {
    if (labels[AUTO_REMOVE_LABEL] === 'true') {
      await removeDockerSandboxResources(
        { containerName, taskNetwork },
        runDocker,
      );
    }
    return;
  }

  if (controlNetwork) {
    await connectTrustedControlPlaneServices(
      controlNetwork,
      taskNetwork,
      runDocker,
    );
  }

  if (!isPastProvisioningTimeout || labels[AUTO_REMOVE_LABEL] !== 'true') {
    return;
  }

  // Fail open from here: never force-remove a running container whose task
  // run we cannot positively identify as finished.
  const taskRunId = Number(labels[TASK_RUN_ID_LABEL]);

  if (!Number.isInteger(taskRunId)) {
    return;
  }

  let processList: string;

  try {
    processList = await runDocker(['exec', containerName, 'ps', '-eo', 'args']);
  } catch {
    // The container likely exited between inspect and exec; the next cycle
    // observes the stopped state and reaps it through the branch above.
    return;
  }

  if (!processListIncludesDockerWorkerRun(processList, taskRunId)) {
    await removeDockerSandboxResources(
      { containerName, taskNetwork },
      runDocker,
    );
  }
}

async function connectTrustedControlPlaneServices(
  controlNetworkName: string,
  taskNetworkName: string,
  runDocker: DockerCommand,
): Promise<void> {
  const controlNetwork = await inspectNetwork(controlNetworkName, runDocker);

  if (!controlNetwork?.Id) {
    throw new Error(
      `Docker worker control network does not exist: ${controlNetworkName}`,
    );
  }

  const connectedServices = new Set<string>();

  for (const [containerId, endpoint] of Object.entries(
    controlNetwork.Containers ?? {},
  )) {
    const container = await inspectContainer(containerId, runDocker);
    const labels = container?.Config?.Labels ?? {};
    const service =
      labels['dev.roomote.docker-worker.trusted-service'] ??
      labels['com.docker.compose.service'];

    if (!service || !TRUSTED_COMPOSE_SERVICES.has(service)) {
      continue;
    }

    const sourceEndpoint = Object.values(
      container?.NetworkSettings?.Networks ?? {},
    ).find((network) => network.NetworkID === controlNetwork.Id);
    const aliases = [...(sourceEndpoint?.Aliases ?? []), endpoint.Name].filter(
      (alias): alias is string => Boolean(alias && !alias.includes(':')),
    );

    if (!container?.NetworkSettings?.Networks?.[taskNetworkName]) {
      try {
        await runDocker([
          'network',
          'connect',
          ...[...new Set(aliases)].flatMap((alias) => ['--alias', alias]),
          taskNetworkName,
          containerId,
        ]);
      } catch (error) {
        // A concurrent spawn or reaper cycle can win the inspect-then-connect
        // race; the endpoint existing is the outcome we wanted.
        if (!isDockerAlreadyConnectedError(error)) {
          throw error;
        }
      }
    }
    connectedServices.add(service);
  }

  const missingServices = REQUIRED_TRUSTED_COMPOSE_SERVICES.filter(
    (service) => !connectedServices.has(service),
  );

  if (missingServices.length > 0) {
    throw new Error(
      `Docker worker control network ${controlNetworkName} is missing trusted service(s): ${missingServices.join(', ')}. Compose services must use the standard service labels, or set dev.roomote.docker-worker.trusted-service.`,
    );
  }
}

async function removeDockerTaskNetwork(
  taskNetwork: string,
  runDocker: DockerCommand,
): Promise<void> {
  const network = await inspectNetwork(taskNetwork, runDocker);

  for (const containerId of Object.keys(network?.Containers ?? {})) {
    await runDocker(['network', 'disconnect', '-f', taskNetwork, containerId], {
      allowFailure: true,
    });
  }

  await runDocker(['network', 'rm', taskNetwork], { allowFailure: true });
}

function getEgressPolicyHelperContainerName(containerName: string): string {
  return `${containerName}-egress-policy`;
}

async function inspectNetwork(
  networkName: string,
  runDocker: DockerCommand,
): Promise<DockerNetworkInspect | undefined> {
  let output: string;

  try {
    output = await runDocker(['network', 'inspect', networkName]);
  } catch (error) {
    if (isDockerObjectNotFoundError(error)) {
      return undefined;
    }
    throw error;
  }

  if (!output.trim()) {
    return undefined;
  }

  const parsed = JSON.parse(output) as DockerNetworkInspect[];
  return parsed[0];
}

async function inspectContainer(
  containerIdOrName: string,
  runDocker: DockerCommand,
): Promise<DockerContainerInspect | undefined> {
  let output: string;

  try {
    output = await runDocker(['inspect', containerIdOrName]);
  } catch (error) {
    if (isDockerObjectNotFoundError(error)) {
      return undefined;
    }
    throw error;
  }

  if (!output.trim()) {
    return undefined;
  }

  const parsed = JSON.parse(output) as DockerContainerInspect[];
  return parsed[0];
}

function getDockerErrorOutput(error: unknown): string {
  const errorWithOutput = error as {
    message?: unknown;
    stderr?: unknown;
    stdout?: unknown;
  };

  return [
    errorWithOutput?.message,
    errorWithOutput?.stderr,
    errorWithOutput?.stdout,
  ]
    .filter((value): value is string => typeof value === 'string')
    .join('\n');
}

function isDockerObjectNotFoundError(error: unknown): boolean {
  const output = getDockerErrorOutput(error);

  return [
    /no such (?:object|container|network)/i,
    /network .+ not found/i,
  ].some((pattern) => pattern.test(output));
}

function isDockerAlreadyConnectedError(error: unknown): boolean {
  const output = getDockerErrorOutput(error);

  return [/already exists in network/i, /is already attached to network/i].some(
    (pattern) => pattern.test(output),
  );
}
