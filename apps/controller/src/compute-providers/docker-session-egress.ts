import {
  buildSessionEgressServiceTokenEnv,
  SESSION_EGRESS_CONNECTOR_PORT,
  SESSION_EGRESS_WORKLOAD_ENV,
  type SessionEgressWorkloadRegistration,
} from '@roomote/types';
import { removeDockerSessionEgressBoundary } from '@roomote/compute-providers';

import {
  buildDockerWorkerLabels,
  docker,
  DOCKER_SESSION_EGRESS_CONNECTOR_ALIAS,
  getDockerSessionEgressConnectorContainerName,
  type DockerCommand,
} from './docker-sandbox-security';

/**
 * Docker wiring for a registered Session-egress workload.
 *
 * Three pieces, none of which hands the worker anything but substitutes,
 * the public gateway CA, and a proxy address:
 *
 * 1. The connector sidecar: the pinned Iron image's `connector` command
 *    in its own container on the task network. Its client certificate
 *    and key are streamed into that container over `docker cp -` before it
 *    starts, so they exist only inside the connector's filesystem.
 * 2. The public CA bundle in the worker: system roots + the gateway's public
 *    MITM CA, so ordinary clients keep verifying TLS.
 * 3. The worker launcher env: the delivery contract the worker turns into
 *    HTTPS_PROXY/CA variables and `ROOMOTE_SERVICE_TOKEN_*` values.
 */

/** Directory the connector image reserves for controller-provisioned material. */
const DOCKER_CONNECTOR_STATE_DIR = '/var/lib/roomote-connector';
const DOCKER_CONNECTOR_CERT_FILE = `${DOCKER_CONNECTOR_STATE_DIR}/connector.crt`;
const DOCKER_CONNECTOR_KEY_FILE = `${DOCKER_CONNECTOR_STATE_DIR}/connector.key`;
const DOCKER_CONNECTOR_GATEWAY_CA_FILE = `${DOCKER_CONNECTOR_STATE_DIR}/gateway-ca.pem`;
/** distroless `nonroot` uid/gid: the connector process owner. */
const CONNECTOR_UID = 65532;

/** Where the worker finds the PUBLIC CA bundle (system roots + gateway CA). */
const DOCKER_WORKER_SESSION_EGRESS_DIR = '/etc/roomote/session-egress';
const DOCKER_WORKER_SESSION_EGRESS_GATEWAY_CA_FILE = `${DOCKER_WORKER_SESSION_EGRESS_DIR}/gateway-ca.pem`;
const DOCKER_WORKER_SESSION_EGRESS_CA_BUNDLE_FILE = `${DOCKER_WORKER_SESSION_EGRESS_DIR}/ca-bundle.pem`;

function getDockerSessionEgressProxyUrl(): string {
  return `http://${DOCKER_SESSION_EGRESS_CONNECTOR_ALIAS}:${SESSION_EGRESS_CONNECTOR_PORT}`;
}

/** Retained resource cleanup is independent of the new run's grant eligibility. */
export async function resetDockerSessionEgressForResume(
  input: {
    workerContainerName: string;
    taskNetwork: string;
    retireSource: () => Promise<void>;
  },
  runDocker: DockerCommand = docker,
): Promise<void> {
  await input.retireSource();
  await runDocker(
    [
      'rm',
      '-f',
      getDockerSessionEgressConnectorContainerName(input.workerContainerName),
    ],
    { allowFailure: true },
  );
  const raw = await runDocker(['network', 'inspect', input.taskNetwork]);
  const [network] = raw.trim() ? JSON.parse(raw) : [];
  if (network) await removeDockerSessionEgressBoundary(network, runDocker);
}

export async function startDockerSessionEgressConnector(
  params: {
    workerContainerName: string;
    taskRunId: number;
    taskNetwork: string;
    platform: string;
    image: string;
    gatewayAddr: string;
    gatewayNetwork?: string;
    gatewayServerCaPem?: string;
    certificatePem: string;
    privateKeyPem: string;
    autoRemove: boolean;
    logMaxSize: string;
    logMaxFiles: number;
  },
  runDocker: DockerCommand = docker,
): Promise<string> {
  const containerName = getDockerSessionEgressConnectorContainerName(
    params.workerContainerName,
  );
  await runDocker(['rm', '-f', containerName], { allowFailure: true });

  // Create, provision, then start: the key exists nowhere until it is inside
  // this container's filesystem, and the process never runs without it.
  await runDocker([
    'create',
    ...(params.autoRemove ? ['--rm'] : []),
    '--name',
    containerName,
    '--platform',
    params.platform,
    '--network',
    params.taskNetwork,
    '--network-alias',
    DOCKER_SESSION_EGRESS_CONNECTOR_ALIAS,
    '--init',
    '--cpus',
    '0.5',
    '--memory',
    '128m',
    '--memory-swap',
    '128m',
    '--pids-limit',
    '64',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--log-driver',
    'json-file',
    '--log-opt',
    `max-size=${params.logMaxSize}`,
    '--log-opt',
    `max-file=${params.logMaxFiles}`,
    ...buildDockerWorkerLabels({
      taskRunId: params.taskRunId,
      autoRemove: params.autoRemove,
    }),
    '--env',
    `SESSION_EGRESS_CONNECTOR_LISTEN_ADDR=${DOCKER_SESSION_EGRESS_CONNECTOR_ALIAS}:${SESSION_EGRESS_CONNECTOR_PORT}`,
    '--env',
    `SESSION_EGRESS_CONNECTOR_GATEWAY_ADDR=${params.gatewayAddr}`,
    '--env',
    `SESSION_EGRESS_CONNECTOR_CERT_FILE=${DOCKER_CONNECTOR_CERT_FILE}`,
    '--env',
    `SESSION_EGRESS_CONNECTOR_KEY_FILE=${DOCKER_CONNECTOR_KEY_FILE}`,
    ...(params.gatewayServerCaPem
      ? [
          '--env',
          `SESSION_EGRESS_CONNECTOR_GATEWAY_CA_FILE=${DOCKER_CONNECTOR_GATEWAY_CA_FILE}`,
        ]
      : []),
    '--entrypoint',
    '/session-egress-gateway',
    params.image,
    'connector',
  ]);

  const files: TarEntry[] = [
    { name: 'connector.crt', content: params.certificatePem, mode: 0o400 },
    { name: 'connector.key', content: params.privateKeyPem, mode: 0o400 },
    ...(params.gatewayServerCaPem
      ? [
          {
            name: 'gateway-ca.pem',
            content: params.gatewayServerCaPem,
            mode: 0o444,
          },
        ]
      : []),
  ];
  try {
    await runDocker(['cp', '-', `${containerName}:/`], {
      input: buildTarArchive(
        files.map((entry) => ({
          ...entry,
          name: `${DOCKER_CONNECTOR_STATE_DIR.slice(1)}/${entry.name}`,
        })),
        { uid: CONNECTOR_UID, gid: CONNECTOR_UID },
      ),
    });

    if (params.gatewayNetwork) {
      await runDocker([
        'network',
        'connect',
        params.gatewayNetwork,
        containerName,
      ]);
    }

    await runDocker(['start', containerName]);
  } catch {
    await runDocker(['rm', '-f', containerName], { allowFailure: true });
    // Docker diagnostic output may contain stdin; never surface provisioning material.
    throw new Error('Session egress connector provisioning failed');
  }
  return containerName;
}

/**
 * Install the public trust bundle into the worker: the image's system roots
 * followed by the gateway's public CA. Only public certificate material.
 */
export async function installDockerSessionEgressCaBundle(
  params: { workerContainerName: string; gatewayCaCertificatePem: string },
  runDocker: DockerCommand = docker,
): Promise<string> {
  await runDocker(['cp', '-', `${params.workerContainerName}:/etc`], {
    input: buildTarArchive(
      [
        {
          name: 'roomote/session-egress/gateway-ca.pem',
          content: params.gatewayCaCertificatePem,
          mode: 0o444,
        },
      ],
      { uid: 0, gid: 0 },
    ),
  });
  await runDocker([
    'exec',
    '-u',
    'root',
    params.workerContainerName,
    'sh',
    '-c',
    [
      `set -e`,
      `for candidate in /etc/ssl/certs/ca-certificates.crt /etc/pki/tls/certs/ca-bundle.crt /etc/ssl/cert.pem; do`,
      `  if [ -r "$candidate" ]; then system_bundle="$candidate"; break; fi`,
      `done`,
      `cat \${system_bundle:-/dev/null} ${DOCKER_WORKER_SESSION_EGRESS_GATEWAY_CA_FILE} > ${DOCKER_WORKER_SESSION_EGRESS_CA_BUNDLE_FILE}`,
      `chmod 0444 ${DOCKER_WORKER_SESSION_EGRESS_CA_BUNDLE_FILE}`,
    ].join('\n'),
  ]);
  return DOCKER_WORKER_SESSION_EGRESS_CA_BUNDLE_FILE;
}

/**
 * Launcher env for a registered workload. Substitutes only: the real
 * credential, the connector key, and the CA private keys are never inputs
 * here. `noProxyHosts` must name every control-plane host the worker and
 * task processes reach directly (API, preview proxy, mock services).
 */
export function buildDockerSessionEgressWorkerEnv(params: {
  registration: SessionEgressWorkloadRegistration;
  caBundleFile: string;
  noProxyHosts: readonly string[];
}): Record<string, string> {
  const { tokens, manifest } = buildSessionEgressServiceTokenEnv(
    params.registration.substitutes,
  );
  for (const token of Object.values(tokens)) {
    if (!token.startsWith('rses_')) {
      throw new Error(
        'Refusing to deliver a session egress value that is not a substitute token',
      );
    }
  }
  const noProxy = [
    ...new Set(
      [
        'localhost',
        '127.0.0.1',
        '::1',
        DOCKER_SESSION_EGRESS_CONNECTOR_ALIAS,
        ...params.noProxyHosts,
      ]
        .map((host) => host.trim())
        .filter(Boolean),
    ),
  ].join(',');
  return {
    [SESSION_EGRESS_WORKLOAD_ENV.PROXY_URL]: getDockerSessionEgressProxyUrl(),
    [SESSION_EGRESS_WORKLOAD_ENV.CA_FILE]: params.caBundleFile,
    [SESSION_EGRESS_WORKLOAD_ENV.NO_PROXY]: noProxy,
    [SESSION_EGRESS_WORKLOAD_ENV.SERVICES]: JSON.stringify(manifest),
    ...tokens,
  };
}

/** Hostnames task processes must reach without the proxy, derived from URLs. */
export function collectNoProxyHosts(
  urls: ReadonlyArray<string | undefined>,
): string[] {
  const hosts = new Set<string>();
  for (const value of urls) {
    if (!value) continue;
    try {
      hosts.add(new URL(value).hostname);
    } catch {
      // Not a URL (e.g. a bare host): use as-is.
      if (/^[A-Za-z0-9.-]+$/.test(value)) hosts.add(value);
    }
  }
  return [...hosts];
}

// ---- minimal ustar writer ---------------------------------------------------

type TarEntry = { name: string; content: string; mode: number };

/**
 * Enough of POSIX ustar for `docker cp -`: regular files (and the directories
 * leading to them) with explicit owner and mode. No dependency, no temp file.
 */
function buildTarArchive(
  entries: TarEntry[],
  owner: { uid: number; gid: number },
): Buffer {
  const blocks: Buffer[] = [];
  const seenDirs = new Set<string>();
  for (const entry of entries) {
    const parts = entry.name.split('/');
    for (let i = 1; i < parts.length; i += 1) {
      const dir = `${parts.slice(0, i).join('/')}/`;
      if (seenDirs.has(dir)) continue;
      seenDirs.add(dir);
      blocks.push(
        tarHeader({ name: dir, size: 0, mode: 0o755, type: '5', owner }),
      );
    }
    const content = Buffer.from(entry.content, 'utf8');
    blocks.push(
      tarHeader({
        name: entry.name,
        size: content.length,
        mode: entry.mode,
        type: '0',
        owner,
      }),
      content,
      Buffer.alloc((512 - (content.length % 512)) % 512),
    );
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

function tarHeader(input: {
  name: string;
  size: number;
  mode: number;
  type: '0' | '5';
  owner: { uid: number; gid: number };
}): Buffer {
  if (Buffer.byteLength(input.name) > 100) {
    throw new Error(`tar entry name too long: ${input.name}`);
  }
  const header = Buffer.alloc(512);
  const octal = (value: number, length: number) =>
    value.toString(8).padStart(length - 1, '0');
  header.write(input.name, 0, 'utf8');
  header.write(octal(input.mode & 0o7777, 8), 100, 'ascii');
  header.write(octal(input.owner.uid, 8), 108, 'ascii');
  header.write(octal(input.owner.gid, 8), 116, 'ascii');
  header.write(octal(input.size, 12), 124, 'ascii');
  header.write(octal(Math.floor(Date.now() / 1000), 12), 136, 'ascii');
  header.write('        ', 148, 'ascii'); // checksum placeholder
  header.write(input.type, 156, 'ascii');
  header.write('ustar', 257, 'ascii');
  header.write('00', 263, 'ascii');
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return header;
}
