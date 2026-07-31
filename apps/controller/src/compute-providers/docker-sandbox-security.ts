import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { TaskRunErrorCode } from '@roomote/types';

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
  options?: { allowFailure?: boolean; signal?: AbortSignal },
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

type DockerExecFailure = {
  code?: string | number | null;
  cmd?: string;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
  message?: string;
  killed?: boolean;
  signal?: NodeJS.Signals | null;
};

function bufferToString(value: string | Buffer | undefined): string {
  if (typeof value === 'string') {
    return value;
  }

  if (Buffer.isBuffer(value)) {
    return value.toString('utf8');
  }

  return '';
}

/** Hide env values from docker CLI diagnostics so auth tokens never reach the UI. */
export function sanitizeDockerCommandForDisplay(
  command: string | string[],
): string {
  if (Array.isArray(command)) {
    const sanitized: string[] = [];

    for (let index = 0; index < command.length; index += 1) {
      const arg = command[index] ?? '';

      if ((arg === '-e' || arg === '--env') && index + 1 < command.length) {
        sanitized.push(arg);
        const next = command[index + 1] ?? '';
        const eq = next.indexOf('=');
        sanitized.push(
          eq > 0 ? `${next.slice(0, eq)}=<redacted>` : '<redacted>',
        );
        index += 1;
        continue;
      }

      sanitized.push(arg);
    }

    return `docker ${sanitized.join(' ')}`.trim();
  }

  // Unquoted values are redacted to the next whitespace only: worker env
  // values must stay space-free or the remainder would survive redaction.
  return command
    .replace(
      /(^|\s)(-e|--env)\s+([A-Za-z_][\w]*)=(?:"[^"]*"|'[^']*'|\S+)/g,
      '$1$2 $3=<redacted>',
    )
    .replace(
      /(^|\s)(-e|--env)=([A-Za-z_][\w]*)=(?:"[^"]*"|'[^']*'|\S+)/g,
      '$1$2=$3=<redacted>',
    )
    .trim();
}

/**
 * Prefer Docker's diagnostic output (stderr/stdout) over the full argv list
 * so spawn failures surface *why* the command failed in the product UI.
 */
export function formatDockerCommandError(
  args: string[],
  error: unknown,
): string {
  const failure = (error ?? {}) as DockerExecFailure;
  const stderr = sanitizeDockerCommandForDisplay(
    bufferToString(failure.stderr).trim(),
  );
  const stdout = sanitizeDockerCommandForDisplay(
    bufferToString(failure.stdout).trim(),
  );
  const command =
    typeof failure.cmd === 'string' && failure.cmd.trim()
      ? sanitizeDockerCommandForDisplay(failure.cmd)
      : sanitizeDockerCommandForDisplay(args);
  const operation = args[0] ? `docker ${args[0]}` : 'docker';
  // Node's execFile error.message embeds the full argv (including -e secrets)
  // when stderr/stdout are empty — always redact before surfacing.
  const reason = sanitizeDockerCommandForDisplay(
    stderr ||
      stdout ||
      (typeof failure.message === 'string' ? failure.message.trim() : '') ||
      `${operation} failed`,
  );

  const details: string[] = [`Failed to run ${operation}.`, reason];

  if (stdout && stdout !== reason) {
    details.push(`stdout:\n${stdout}`);
  }

  if (failure.code !== undefined && failure.code !== null) {
    details.push(`exit code: ${String(failure.code)}`);
  }

  details.push(`command:\n${command}`);

  return details.filter(Boolean).join('\n\n');
}

/**
 * Boot/spawn failure with a machine-readable category. Thrown at the sites
 * that know exactly what went wrong (preflight, worker start assertions) so
 * the category survives to finishRun without re-parsing error prose.
 */
export class DockerBootError extends Error {
  readonly errorCode: TaskRunErrorCode;

  constructor(errorCode: TaskRunErrorCode, message: string) {
    super(message);
    this.name = 'DockerBootError';
    this.errorCode = errorCode;
  }
}

export function getTaskRunErrorCode(
  error: unknown,
): TaskRunErrorCode | undefined {
  return error instanceof DockerBootError ? error.errorCode : undefined;
}

const SPAWN_ERROR_CLASSIFIERS: ReadonlyArray<{
  code: TaskRunErrorCode;
  pattern: RegExp;
}> = [
  {
    code: TaskRunErrorCode.DockerDaemonUnreachable,
    pattern:
      /Cannot connect to the Docker daemon|failed to connect to the [Dd]ocker API|Is the docker daemon running|docker\.sock.*connect: no such file or directory/i,
  },
  {
    code: TaskRunErrorCode.DockerImageMissing,
    pattern:
      /pull access denied|repository does not exist or may require ['"]?docker login['"]?|manifest for .+ not found|Unable to find image ['"].+['"] locally/i,
  },
  {
    code: TaskRunErrorCode.DockerAddressPoolExhausted,
    pattern: /all predefined address pools have been fully subnetted/i,
  },
  {
    code: TaskRunErrorCode.DockerPortInUse,
    pattern:
      /port is already allocated|bind: address already in use|failed to bind host port/i,
  },
  {
    code: TaskRunErrorCode.DockerReleaseArchiveMissing,
    pattern:
      /Docker worker release archive does not exist|Docker provider requires a local worker release archive/i,
  },
];

/**
 * Fallback categorization for spawn failures that were not raised as
 * DockerBootError (e.g. a docker run failure surfacing daemon stderr).
 * Single source of truth for these patterns — the web app matches on the
 * persisted code, not on error prose.
 */
export function classifyDockerSpawnError(
  message: string,
): TaskRunErrorCode | undefined {
  return SPAWN_ERROR_CLASSIFIERS.find(({ pattern }) => pattern.test(message))
    ?.code;
}

/** Normalize spawn failures so finishRun stores a useful diagnostic message. */
export function formatSpawnWorkerError(error: unknown): string {
  if (error instanceof Error) {
    const failure = error as Error & DockerExecFailure;
    const stderr = sanitizeDockerCommandForDisplay(
      bufferToString(failure.stderr).trim(),
    );
    const stdout = sanitizeDockerCommandForDisplay(
      bufferToString(failure.stdout).trim(),
    );
    const message = error.message.trim();

    // Already formatted by formatDockerCommandError / spawn-docker-worker.
    if (message.startsWith('Failed to run docker')) {
      return sanitizeDockerCommandForDisplay(message);
    }

    if (stderr || stdout) {
      return formatDockerCommandError(
        typeof failure.cmd === 'string'
          ? failure.cmd.replace(/^docker\s+/, '').split(/\s+/)
          : [],
        error,
      );
    }

    return sanitizeDockerCommandForDisplay(message) || 'Worker spawn failed';
  }

  if (typeof error === 'string' && error.trim()) {
    return sanitizeDockerCommandForDisplay(error.trim());
  }

  return String(error);
}

export async function docker(
  args: string[],
  options: { allowFailure?: boolean; signal?: AbortSignal } = {},
): Promise<string> {
  try {
    const { stdout } = await execFileAsync('docker', args, {
      cwd: resolveFromWorkspaceRoot('.'),
      maxBuffer: 10 * 1024 * 1024,
      signal: options.signal,
    });

    return stdout;
  } catch (error) {
    // Cancellation must not be treated as a soft failure; allowFailure only
    // covers Docker CLI / object-state errors, not AbortSignal abort.
    if (options.signal?.aborted || isAbortError(error)) {
      throw error;
    }

    if (options.allowFailure) {
      return '';
    }

    // Do not attach the raw execFile error as `cause`: Sentry LinkedErrors
    // would serialize the unredacted argv (including AUTH_TOKEN) from it.
    throw new Error(formatDockerCommandError(args, error));
  }
}

export function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.name === 'AbortError' ||
    error.name === 'TimeoutError' ||
    // Node's aborted execFile errors use this code.
    ('code' in error && error.code === 'ABORT_ERR')
  );
}

export function getDockerTaskNetworkName(taskRunId: number): string {
  return `${TASK_NETWORK_PREFIX}${taskRunId}`;
}

export function getDockerWorkerContainerName(taskRunId: number): string {
  return `${WORKER_CONTAINER_PREFIX}${taskRunId}`;
}

export function getDockerTaskDaemonContainerName(
  workerContainerName: string,
): string {
  return `${workerContainerName}-docker`;
}

export function getDockerTaskWorkspaceVolumeName(
  workerContainerName: string,
): string {
  return `${workerContainerName}-workspace`;
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

export function buildDockerTaskDaemonResourceArgs(
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
    '--log-driver',
    'json-file',
    '--log-opt',
    `max-size=${limits.logMaxSize}`,
    '--log-opt',
    `max-file=${limits.logMaxFiles}`,
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
        new RegExp(
          `(?:^|\\s)worker\\s+(?:run|resume)\\s+${escapedTaskRunId}(?:\\s|$)`,
        ),
        new RegExp(
          `(?:^|[\\s/])worker\\.js\\s+(?:run|resume)\\s+${escapedTaskRunId}(?:\\s|$)`,
        ),
      ].some((pattern) => pattern.test(line)),
    );
}

function processListIncludesDockerWorkerProcess(processList: string): boolean {
  return processList
    .split('\n')
    .some((line) =>
      [
        /(?:^|\s)worker\s+(?:run|resume)\s+\d+(?:\s|$)/,
        /(?:^|[\s/])worker\.js\s+(?:run|resume)\s+\d+(?:\s|$)/,
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
    // Network teardown must not share a possibly-aborted spawn signal.
    await removeDockerTaskNetwork(taskNetwork, docker);
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
    // Legacy iptables needs CAP_NET_RAW on top of CAP_NET_ADMIN. Keep both
    // capabilities because the helper selects the supported backend at runtime.
    '--cap-add',
    'NET_RAW',
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
            // Do not blackhole the default gateway as a host route: on Linux
            // that /32 is more specific than the on-link bridge subnet and
            // breaks next-hop resolution for public egress (git clone, HTTPS).
            // Drop only packets destined TO the gateway IP so host hairpin is
            // blocked while using the gateway as default next-hop still works.
            [
              'gateway="$(ip route show default | awk \'NR == 1 { print $3 }\')"',
              'if [ -n "$gateway" ]; then',
              // Heal namespaces set up by controllers that still blackholed
              // the gateway as a route; retained standby workers keep their
              // netns across controller upgrades.
              '  ip route del blackhole "$gateway/32" 2>/dev/null || true',
              '  find_iptables() {',
              '    for candidate in iptables-nft iptables-legacy iptables; do',
              '      if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -S OUTPUT >/dev/null 2>&1; then',
              '        printf "%s" "$candidate"',
              '        return 0',
              '      fi',
              '    done',
              '    return 1',
              '  }',
              '  iptables_cmd="$(find_iptables || true)"',
              '  if [ -z "$iptables_cmd" ] && command -v apk >/dev/null 2>&1; then',
              '    apk add --no-cache iptables >/dev/null',
              '    iptables_cmd="$(find_iptables || true)"',
              '  fi',
              '  if [ -n "$iptables_cmd" ]; then',
              '    "$iptables_cmd" -C OUTPUT -d "$gateway" -j DROP 2>/dev/null || "$iptables_cmd" -A OUTPUT -d "$gateway" -j DROP',
              // The route blackhole also covered forwarded traffic; keep that
              // property in case the worker netns ever routes packets.
              '    "$iptables_cmd" -C FORWARD -d "$gateway" -j DROP 2>/dev/null || "$iptables_cmd" -A FORWARD -d "$gateway" -j DROP',
              '  else',
              '    echo "no supported iptables backend (nft, legacy, or default); cannot block docker gateway $gateway" >&2',
              '    exit 1',
              '  fi',
              'fi',
            ].join('\n'),
          ]
        : []),
    ].join(' && '),
  ]);
}

/**
 * Restores network state that is not guaranteed to survive while a retained
 * worker container is stopped. Egress routes live in the container network
 * namespace, and trusted control-plane containers may have been recreated
 * while the task was in standby.
 */
export async function restoreDockerStandbyNetworking(
  params: {
    containerName: string;
    taskNetwork: string;
    controlNetwork?: string;
    egressPolicy: DockerWorkerEgressPolicy;
    image: string;
    platform: string;
  },
  runDocker: DockerCommand = docker,
): Promise<void> {
  await attachDockerEgressPolicy(
    {
      containerName: params.containerName,
      egressPolicy: params.egressPolicy,
      image: params.image,
      platform: params.platform,
      blockDockerGateway: Boolean(params.controlNetwork),
    },
    runDocker,
  );

  if (params.controlNetwork) {
    await connectTrustedControlPlaneServices(
      params.controlNetwork,
      params.taskNetwork,
      runDocker,
    );
  }
}

export async function removeDockerSandboxResources(
  params: { containerName: string; taskNetwork: string },
  runDocker: DockerCommand = docker,
): Promise<void> {
  await runDocker(
    ['rm', '-f', getEgressPolicyHelperContainerName(params.containerName)],
    { allowFailure: true },
  );
  await runDocker(
    ['rm', '-f', getDockerTaskDaemonContainerName(params.containerName)],
    { allowFailure: true },
  );
  await runDocker(['rm', '-f', params.containerName], { allowFailure: true });
  await runDocker(
    [
      'volume',
      'rm',
      '-f',
      getDockerTaskWorkspaceVolumeName(params.containerName),
    ],
    { allowFailure: true },
  );
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

  if (!processListIncludesDockerWorkerProcess(processList)) {
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
