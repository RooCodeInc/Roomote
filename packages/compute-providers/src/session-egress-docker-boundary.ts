import { isIP } from 'node:net';

import { SESSION_EGRESS_CONNECTOR_PORT } from '@roomote/types';

type DockerCommand = (
  args: string[],
  options?: { signal?: AbortSignal; allowFailure?: boolean },
) => Promise<string>;

export const SESSION_EGRESS_POLICY_IMAGE_LABEL =
  'dev.roomote.session-egress.policy-image';
export const SESSION_EGRESS_POLICY_PLATFORM_LABEL =
  'dev.roomote.session-egress.policy-platform';

interface TaskNetwork {
  Id: string;
  Internal: boolean;
  Options?: Record<string, string>;
  Labels?: Record<string, string>;
  Containers?: Record<string, { Name: string; IPv4Address: string }>;
}

interface SessionEgressEndpoint {
  address: string;
  port: number;
}

/** Host policy, outside the worker and its privileged nested Docker namespace. */
export function buildSessionEgressHostPolicy(
  networkId: string,
  bridge: string,
  endpoints: readonly SessionEgressEndpoint[],
  workerInterface: string,
): string {
  if (
    !/^[a-f0-9]{64}$/.test(networkId) ||
    !/^[a-zA-Z0-9_-]{1,15}$/.test(bridge) ||
    !/^[a-zA-Z0-9_-]{1,15}$/.test(workerInterface)
  ) {
    throw new Error('Invalid Session egress network identity');
  }
  if (
    endpoints.length === 0 ||
    endpoints.some(
      ({ address, port }) =>
        isIP(address) !== 4 ||
        !Number.isInteger(port) ||
        port < 1 ||
        port > 65535,
    )
  ) {
    throw new Error('Invalid Session egress endpoint');
  }
  const chain = `RSE_${networkId.slice(0, 12)}`;
  const inputChain = `${chain}_I`;
  const guard = `${chain}_G`;
  return [
    'set -eu',
    // Bridge traffic must traverse the host filter, including same-bridge peers.
    'test "$(cat /proc/sys/net/bridge/bridge-nf-call-iptables)" = 1',
    'test "$(cat /proc/sys/net/bridge/bridge-nf-call-ip6tables)" = 1',
    'iptables -S DOCKER-USER >/dev/null',
    'iptables -C FORWARD -j DOCKER-USER',
    // Keep a deny guard while rebuilding; failure never restores permissive egress.
    `iptables -N ${guard} 2>/dev/null || true`,
    `iptables -A ${guard} -m physdev --physdev-in ${workerInterface} -j DROP`,
    `iptables -I DOCKER-USER 1 -i ${bridge} -j ${guard}`,
    `iptables -N ${inputChain} 2>/dev/null || iptables -F ${inputChain}`,
    `iptables -A ${inputChain} -m physdev ! --physdev-in ${workerInterface} -j RETURN`,
    `iptables -A ${inputChain} -j DROP`,
    `iptables -C INPUT -i ${bridge} -j ${inputChain} 2>/dev/null || iptables -I INPUT 1 -i ${bridge} -j ${inputChain}`,
    `ip6tables -N ${inputChain} 2>/dev/null || ip6tables -F ${inputChain}`,
    `ip6tables -A ${inputChain} -m physdev ! --physdev-in ${workerInterface} -j RETURN`,
    `ip6tables -A ${inputChain} -j DROP`,
    `ip6tables -C INPUT -i ${bridge} -j ${inputChain} 2>/dev/null || ip6tables -I INPUT 1 -i ${bridge} -j ${inputChain}`,
    `ip6tables -C FORWARD -i ${bridge} -j ${inputChain} 2>/dev/null || ip6tables -I FORWARD 1 -i ${bridge} -j ${inputChain}`,
    `iptables -N ${chain} 2>/dev/null || iptables -F ${chain}`,
    `iptables -A ${chain} -m physdev ! --physdev-in ${workerInterface} -j RETURN`,
    // Responses to trusted inbound API/preview connections may use ephemeral ports.
    ...endpoints.map(
      ({ address }) =>
        `iptables -A ${chain} -d ${address} -p tcp -m conntrack --ctstate ESTABLISHED --ctdir REPLY -j RETURN`,
    ),
    ...endpoints.map(
      ({ address, port }) =>
        `iptables -A ${chain} -d ${address} -p tcp --dport ${port} -j RETURN`,
    ),
    `iptables -A ${chain} -j DROP`,
    `iptables -C DOCKER-USER -i ${bridge} -j ${chain} 2>/dev/null && iptables -D DOCKER-USER -i ${bridge} -j ${chain} || true`,
    `iptables -I DOCKER-USER 1 -i ${bridge} -j ${chain}`,
    `while iptables -C DOCKER-USER -i ${bridge} -j ${guard} 2>/dev/null; do iptables -D DOCKER-USER -i ${bridge} -j ${guard}; done`,
    `iptables -F ${guard}`,
    `iptables -X ${guard}`,
    `iptables -C DOCKER-USER -i ${bridge} -j ${chain}`,
    `iptables -C ${chain} -j DROP`,
    `iptables -C INPUT -i ${bridge} -j ${inputChain}`,
    `ip6tables -C INPUT -i ${bridge} -j ${inputChain}`,
    `ip6tables -C FORWARD -i ${bridge} -j ${inputChain}`,
  ].join('\n');
}

export async function installDockerSessionEgressBoundary(
  input: {
    taskNetwork: string;
    connectorName: string;
    workerContainerName: string;
    image: string;
    platform: string;
    controlPorts: { api: number; 'preview-proxy': number };
  },
  runDocker: DockerCommand,
): Promise<void> {
  const [network] = JSON.parse(
    await runDocker(['network', 'inspect', input.taskNetwork]),
  ) as TaskNetwork[];
  if (
    !network ||
    !/^[a-f0-9]{64}$/.test(network.Id) ||
    network.Labels?.[SESSION_EGRESS_POLICY_IMAGE_LABEL] !== input.image ||
    network.Labels?.[SESSION_EGRESS_POLICY_PLATFORM_LABEL] !== input.platform
  ) {
    throw new Error(
      'Session egress requires a controller-owned bootstrap network',
    );
  }
  const endpoints: SessionEgressEndpoint[] = [];
  let connectorFound = false;
  let apiFound = false;
  for (const [id, endpoint] of Object.entries(network.Containers ?? {})) {
    const address = endpoint.IPv4Address.split('/')[0]!;
    if (endpoint.Name === input.connectorName) {
      endpoints.push({ address, port: SESSION_EGRESS_CONNECTOR_PORT });
      connectorFound = true;
      continue;
    }
    const [container] = JSON.parse(
      await runDocker(['container', 'inspect', id]),
    ) as Array<{
      Config?: { Labels?: Record<string, string> };
    }>;
    const labels = container?.Config?.Labels;
    const service =
      labels?.['dev.roomote.docker-worker.trusted-service'] ??
      labels?.['com.docker.compose.service'];
    if (service === 'api' || service === 'preview-proxy') {
      endpoints.push({ address, port: input.controlPorts[service] });
      apiFound ||= service === 'api';
    }
  }
  if (!connectorFound || !apiFound) {
    throw new Error(
      'Session egress connector or trusted API endpoint is missing',
    );
  }
  const bridge =
    network.Options?.['com.docker.network.bridge.name'] ||
    `br-${network.Id.slice(0, 12)}`;
  const [worker] = JSON.parse(
    await runDocker(['container', 'inspect', input.workerContainerName]),
  ) as Array<{
    State?: { Pid?: number; Running?: boolean };
    NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> };
  }>;
  const pid = worker?.State?.Pid;
  const address =
    worker?.NetworkSettings?.Networks?.[input.taskNetwork]?.IPAddress;
  if (
    !Number.isSafeInteger(pid) ||
    !pid ||
    pid < 1 ||
    worker.State?.Running !== true ||
    !address ||
    isIP(address) !== 4
  ) {
    throw new Error('Session egress worker network identity is unavailable');
  }
  const host = [
    'run',
    '--rm',
    '--network',
    'host',
    '--pid',
    'host',
    '--user',
    'root',
    '--cap-drop',
    'ALL',
    '--cap-add',
    'SYS_ADMIN',
    '--cap-add',
    'NET_ADMIN',
    '--cap-add',
    'SYS_PTRACE',
    '--security-opt',
    'apparmor=unconfined',
    // The worker image installs Node through mise for the roomote user. Root
    // helpers must select that image-owned config explicitly, without relying
    // on root's HOME or any configuration inside the workload filesystem.
    '--env',
    'MISE_CONFIG_FILE=/home/roomote/.config/mise/config.toml',
    '--platform',
    input.platform,
    '--entrypoint',
  ];
  const namespaceName = `roomote-${network.Id.slice(0, 12)}`;
  // Worker netlink data can be fabricated. Attach the Docker-reported PID's
  // namespace in the trusted helper, then require reciprocal host peer indices
  // AND the host-assigned namespace ID. No worker-provided index is authority.
  const inspectScript = [
    `const {execFileSync}=require('node:child_process');`,
    `const name=${JSON.stringify(namespaceName)};`,
    `const read=(...args)=>JSON.parse(execFileSync('ip',args,{encoding:'utf8'}));`,
    `execFileSync('ip',['netns','attach',name,${JSON.stringify(String(pid))}]);`,
    `try {`,
    ` let namespaces=read('-j','netns','list-id');`,
    ` if(!namespaces.some(x=>x.name===name)){execFileSync('ip',['netns','set',name,'auto']);namespaces=read('-j','netns','list-id');}`,
    ` const workloadLinks=read('-n',name,'-j','address','show');`,
    ` const hostLinks=read('-j','link','show');`,
    ` process.stdout.write(JSON.stringify({namespaces,workloadLinks,hostLinks}));`,
    `} finally {execFileSync('ip',['netns','delete',name]);}`,
  ].join('\n');
  const topology = JSON.parse(
    await runDocker([...host, 'node', input.image, '-e', inspectScript]),
  ) as {
    namespaces: Array<{ name?: string; nsid?: number }>;
    workloadLinks: Array<{
      ifindex?: number;
      link_index?: number;
      addr_info?: Array<{ local?: string }>;
    }>;
    hostLinks: Array<{
      ifindex?: number;
      link_index?: number;
      link_netnsid?: number;
      ifname: string;
      master?: string;
    }>;
  };
  const namespaces = topology.namespaces.filter(
    (item) => item.name === namespaceName,
  );
  const links = topology.workloadLinks.filter((link) =>
    link.addr_info?.some((item) => item.local === address),
  );
  const namespaceId = namespaces.length === 1 ? namespaces[0]?.nsid : undefined;
  const link = links.length === 1 ? links[0] : undefined;
  const peers = topology.hostLinks.filter(
    (peer) =>
      peer.ifindex === link?.link_index &&
      peer.link_index === link?.ifindex &&
      peer.link_netnsid === namespaceId &&
      peer.master === bridge,
  );
  const peer = peers.length === 1 ? peers[0] : undefined;
  if (
    !Number.isSafeInteger(namespaceId) ||
    namespaceId! < 0 ||
    !link ||
    !Number.isSafeInteger(link.ifindex) ||
    !peer
  )
    throw new Error(
      'Session egress worker host interface could not be verified',
    );
  const [current] = JSON.parse(
    await runDocker(['container', 'inspect', input.workerContainerName]),
  ) as (typeof worker)[];
  if (
    current?.State?.Pid !== pid ||
    current.State.Running !== true ||
    current.NetworkSettings?.Networks?.[input.taskNetwork]?.IPAddress !==
      address
  ) {
    throw new Error(
      'Session egress worker changed during network verification',
    );
  }
  const script = buildSessionEgressHostPolicy(
    network.Id,
    bridge,
    endpoints,
    peer.ifname,
  );
  await runDocker([
    'run',
    '--rm',
    '--network',
    'host',
    '--user',
    'root',
    '--cap-drop',
    'ALL',
    '--cap-add',
    'NET_ADMIN',
    '--cap-add',
    'NET_RAW',
    '--platform',
    input.platform,
    '--entrypoint',
    '/bin/sh',
    input.image,
    '-c',
    script,
  ]);
}

/** Called only after task endpoints have been stopped/disconnected. */
export async function removeDockerSessionEgressBoundary(
  network: {
    Id?: string;
    Options?: Record<string, string>;
    Labels?: Record<string, string> | null;
  },
  runDocker: DockerCommand,
): Promise<void> {
  const image = network.Labels?.[SESSION_EGRESS_POLICY_IMAGE_LABEL];
  const platform = network.Labels?.[SESSION_EGRESS_POLICY_PLATFORM_LABEL];
  if (!image || !platform) return;
  const id = network.Id ?? '';
  const bridge =
    network.Options?.['com.docker.network.bridge.name'] ||
    `br-${id.slice(0, 12)}`;
  if (!/^[a-f0-9]{64}$/.test(id) || !/^[a-zA-Z0-9_-]{1,15}$/.test(bridge)) {
    throw new Error('Invalid Session egress cleanup network identity');
  }
  const chain = `RSE_${id.slice(0, 12)}`;
  const inputChain = `${chain}_I`;
  const guard = `${chain}_G`;
  const script = [
    'set -eu',
    'iptables -S DOCKER-USER >/dev/null',
    `while iptables -C DOCKER-USER -i ${bridge} -j ${chain} 2>/dev/null; do iptables -D DOCKER-USER -i ${bridge} -j ${chain}; done`,
    `while iptables -C DOCKER-USER -i ${bridge} -j DROP 2>/dev/null; do iptables -D DOCKER-USER -i ${bridge} -j DROP; done`,
    `while iptables -C DOCKER-USER -i ${bridge} -j ${guard} 2>/dev/null; do iptables -D DOCKER-USER -i ${bridge} -j ${guard}; done`,
    `if iptables -S ${guard} >/dev/null 2>&1; then iptables -F ${guard}; iptables -X ${guard}; fi`,
    `iptables -C INPUT -i ${bridge} -j ${inputChain} 2>/dev/null && iptables -D INPUT -i ${bridge} -j ${inputChain} || true`,
    `ip6tables -C INPUT -i ${bridge} -j ${inputChain} 2>/dev/null && ip6tables -D INPUT -i ${bridge} -j ${inputChain} || true`,
    `ip6tables -C FORWARD -i ${bridge} -j ${inputChain} 2>/dev/null && ip6tables -D FORWARD -i ${bridge} -j ${inputChain} || true`,
    `if iptables -S ${inputChain} >/dev/null 2>&1; then iptables -F ${inputChain}; iptables -X ${inputChain}; fi`,
    `if ip6tables -S ${inputChain} >/dev/null 2>&1; then ip6tables -F ${inputChain}; ip6tables -X ${inputChain}; fi`,
    `if iptables -S ${chain} >/dev/null 2>&1; then iptables -F ${chain}; iptables -X ${chain}; fi`,
  ].join('\n');
  await runDocker([
    'run',
    '--rm',
    '--network',
    'host',
    '--user',
    'root',
    '--cap-drop',
    'ALL',
    '--cap-add',
    'NET_ADMIN',
    '--cap-add',
    'NET_RAW',
    '--platform',
    platform,
    '--entrypoint',
    '/bin/sh',
    image,
    '-c',
    script,
  ]);
}
