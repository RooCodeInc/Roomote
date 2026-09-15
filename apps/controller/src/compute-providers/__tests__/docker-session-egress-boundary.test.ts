import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  buildSessionEgressHostPolicy,
  installDockerSessionEgressBoundary,
  removeDockerSessionEgressBoundary,
  SESSION_EGRESS_POLICY_IMAGE_LABEL,
  SESSION_EGRESS_POLICY_PLATFORM_LABEL,
} from '@roomote/compute-providers';
import {
  startDockerSessionEgressConnector,
  resetDockerSessionEgressForResume,
} from '../docker-session-egress';
import {
  prepareDockerTaskNetwork,
  type DockerCommand,
} from '../docker-sandbox-security';

const networkId = 'a'.repeat(64);
const bridge = `br-${networkId.slice(0, 12)}`;

describe('host-enforced Session egress', () => {
  it.each([
    {
      active: 'nft',
      defaultKind: 'nft',
      ipv6: true,
      expected: 'iptables-nft:ip6tables-nft',
    },
    {
      active: 'legacy',
      defaultKind: 'legacy',
      ipv6: true,
      expected: 'iptables-legacy:ip6tables-legacy',
    },
    {
      active: 'both',
      defaultKind: 'nft',
      ipv6: true,
      error: 'Ambiguous Docker firewall backends',
    },
    {
      active: 'none',
      defaultKind: 'nft',
      ipv6: true,
      error: 'Docker firewall backend unavailable',
    },
    {
      active: 'nft',
      defaultKind: 'nft',
      ipv6: false,
      error: 'Matching IPv6 firewall backend unavailable',
    },
  ])(
    'resolves one firewall ruleset or fails closed: $active/$ipv6',
    ({ active, defaultKind, ipv6, expected, error }) => {
      const directory = mkdtempSync(join(tmpdir(), 'firewall-selection-'));
      try {
        const command = [
          '#!/bin/sh',
          'case "${0##*/}" in *-legacy) kind=legacy;; *-nft) kind=nft;; *) kind="$DEFAULT_KIND";; esac',
          'if [ "$1" = "--version" ]; then if [ "$kind" = nft ]; then printf "iptables v1.8.11 (nf_tables)\\n"; else printf "iptables v1.8.11 (legacy)\\n"; fi; exit 0; fi',
          'if [ "$1" = "-S" ] && [ "$2" = "OUTPUT" ]; then exit 0; fi',
          'if [ "$1" = "-S" ] || [ "$1" = "-C" ]; then [ "$ACTIVE" = "$kind" ] || [ "$ACTIVE" = both ]; exit $?; fi',
          'exit 99 # No policy mutation is permitted by this selection test.',
        ].join('\n');
        for (const name of [
          'iptables-nft',
          'iptables-legacy',
          'iptables',
          ...(ipv6 ? ['ip6tables-nft', 'ip6tables-legacy', 'ip6tables'] : []),
        ]) {
          writeFileSync(join(directory, name), command, { mode: 0o700 });
        }
        const policy = buildSessionEgressHostPolicy(
          networkId,
          bridge,
          [{ address: '172.30.0.3', port: 3128 }],
          'veth-worker',
        );
        const boundary = policy.indexOf('test "$(cat /proc/sys/net/bridge/');
        expect(boundary).toBeGreaterThan(0);
        const result = spawnSync(
          '/bin/sh',
          [
            '-c',
            `${policy.slice(0, boundary)}\nprintf '%s:%s' "$rse_iptables" "$rse_ip6tables"`,
          ],
          {
            encoding: 'utf8',
            env: { PATH: directory, ACTIVE: active, DEFAULT_KIND: defaultKind },
          },
        );
        if (expected) {
          expect(result.status).toBe(0);
          expect(result.stdout).toBe(expected);
        } else {
          expect(result.status).not.toBe(0);
          expect(result.stderr).toContain(error);
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it('permits ordinary bootstrap while recording nonsecret owned transition metadata', async () => {
    const runDocker = vi.fn<DockerCommand>().mockResolvedValue('');
    await prepareDockerTaskNetwork(
      {
        taskRunId: 91,
        egressPolicy: 'internet',
        sessionEgress: true,
        sessionEgressPolicyImage: 'trusted-helper',
        sessionEgressPolicyPlatform: 'linux/amd64',
        autoRemove: true,
      },
      runDocker,
    );
    const command = runDocker.mock.calls.find(
      ([args]) => args[0] === 'network' && args[1] === 'create',
    )![0];
    expect(command).not.toContain('--internal');
    expect(command).toContain(
      `${SESSION_EGRESS_POLICY_IMAGE_LABEL}=trusted-helper`,
    );
    expect(command).toContain(
      `${SESSION_EGRESS_POLICY_PLATFORM_LABEL}=linux/amd64`,
    );
  });

  it('restricts the incoming host bridge rather than trusting the worker namespace', () => {
    const script = buildSessionEgressHostPolicy(
      networkId,
      bridge,
      [
        { address: '172.30.0.3', port: 3128 },
        { address: '172.30.0.2', port: 3001 },
      ],
      'veth-worker',
    );
    expect(script).toContain('bridge-nf-call-iptables');
    expect(script).toContain(
      `-A RSE_${networkId.slice(0, 12)}_G -m physdev --physdev-in veth-worker -j DROP`,
    );
    expect(script).toContain('-d 172.30.0.3 -p tcp --dport 3128 -j RETURN');
    expect(script).toContain('-d 172.30.0.2 -p tcp --dport 3001 -j RETURN');
    expect(script).not.toContain('scope link');
    expect(script).not.toContain('-j ACCEPT');
    const conntrackRules = script
      .split('\n')
      .filter((line) => line.includes('--ctstate'));
    expect(conntrackRules).toHaveLength(2);
    expect(
      conntrackRules.every(
        (line) =>
          line.includes('-d 172.30.0.') &&
          line.includes('-p tcp') &&
          line.includes('--ctdir REPLY'),
      ),
    ).toBe(true);
    expect(script).not.toContain('RELATED');
    expect(script).toContain(
      `ip6tables -I FORWARD 1 -i ${bridge} -j RSE_${networkId.slice(0, 12)}_I`,
    );
    expect(
      script.indexOf(
        `-I DOCKER-USER 1 -i ${bridge} -j RSE_${networkId.slice(0, 12)}_G`,
      ),
    ).toBeLessThan(script.indexOf('iptables -F RSE_'));
    expect(script.indexOf('-j RETURN')).toBeLessThan(
      script.lastIndexOf('iptables -D DOCKER-USER'),
    );
  });

  it.each([
    [{ address: '172.30.0.3; touch /tmp/bad', port: 3128 }],
    [{ address: '::1', port: 3128 }],
    [{ address: '172.30.0.3', port: 0 }],
    [{ address: '172.30.0.3', port: 65536 }],
    [],
  ])('rejects invalid trusted endpoint data %j', (...endpoints) => {
    expect(() =>
      buildSessionEgressHostPolicy(networkId, bridge, endpoints, 'veth-worker'),
    ).toThrow();
  });

  it.each([
    'valid',
    'fabricated peer',
    'missing namespace',
    'wrong reciprocal index',
    'ambiguous namespace',
    'changed PID',
  ])(
    'verifies reciprocal host/workload namespace identity: %s',
    async (mode) => {
      let workerReads = 0;
      const runDocker = vi.fn<DockerCommand>(async (args) => {
        if (
          args[0] === 'run' &&
          args.includes('/opt/mise/installs/node/22.17.1/bin/node')
        ) {
          const namespace = {
            name: `roomote-${networkId.slice(0, 12)}`,
            nsid: 7,
          };
          return JSON.stringify({
            namespaces:
              mode === 'ambiguous namespace'
                ? [namespace, { ...namespace, nsid: 8 }]
                : [namespace],
            workloadLinks: [
              {
                ifindex: 2,
                link_index: mode === 'fabricated peer' ? 5555 : 99,
                addr_info: [{ local: '172.30.0.4' }],
              },
            ],
            hostLinks:
              mode === 'fabricated peer'
                ? [
                    {
                      ifindex: 5555,
                      link_index: 2,
                      link_netnsid: 8,
                      ifname: 'veth-api',
                      master: bridge,
                    },
                    {
                      ifindex: 9999,
                      link_index: 8,
                      link_netnsid: 7,
                      ifname: 'veth-worker',
                      master: bridge,
                    },
                  ]
                : [
                    {
                      ifindex: 99,
                      link_index: mode === 'wrong reciprocal index' ? 3 : 2,
                      ...(mode === 'missing namespace'
                        ? {}
                        : { link_netnsid: 7 }),
                      ifname: 'veth-worker',
                      master: bridge,
                    },
                  ],
          });
        }
        if (args[0] === 'network')
          return JSON.stringify([
            {
              Id: networkId,
              Internal: false,
              Labels: {
                [SESSION_EGRESS_POLICY_IMAGE_LABEL]: 'trusted-helper',
                [SESSION_EGRESS_POLICY_PLATFORM_LABEL]: 'linux/amd64',
              },
              Containers: {
                connector: {
                  Name: 'connector-test',
                  IPv4Address: '172.30.0.3/24',
                },
                api: { Name: 'api', IPv4Address: '172.30.0.2/24' },
                worker: { Name: 'worker', IPv4Address: '172.30.0.4/24' },
              },
            },
          ]);
        if (args[0] === 'container') {
          if (args[2] === 'worker') workerReads += 1;
          return JSON.stringify([
            {
              State: {
                Pid: mode === 'changed PID' && workerReads >= 3 ? 101 : 100,
                Running: true,
              },
              NetworkSettings: {
                Networks: { 'roomote-task-1': { IPAddress: '172.30.0.4' } },
              },
              Config: {
                Labels: {
                  'com.docker.compose.service':
                    args[2] === 'api' ? 'api' : 'untrusted',
                },
              },
            },
          ]);
        }
        return '';
      });
      const installation = installDockerSessionEgressBoundary(
        {
          taskNetwork: 'roomote-task-1',
          connectorName: 'connector-test',
          workerContainerName: 'worker',
          image: 'trusted-helper',
          platform: 'linux/amd64',
          controlPorts: { api: 3001, 'preview-proxy': 8081 },
        },
        runDocker,
      );
      if (mode !== 'valid') {
        await expect(installation).rejects.toThrow(
          /could not be verified|changed during network verification/,
        );
        expect(
          runDocker.mock.calls.some(([args]) => args.includes('/bin/sh')),
        ).toBe(false);
        return;
      }
      await installation;
      const command = runDocker.mock.calls.at(-1)![0];
      expect(command.slice(0, 4)).toEqual(['run', '--rm', '--network', 'host']);
      expect(command).not.toContain('container:worker');
      expect(command.at(-1)).toContain('172.30.0.3');
      expect(command.at(-1)).not.toContain('172.30.0.4');
    },
  );

  it('refuses a legacy external task network before starting the host helper', async () => {
    const runDocker = vi.fn<DockerCommand>(async () =>
      JSON.stringify([{ Id: networkId, Internal: false }]),
    );
    await expect(
      installDockerSessionEgressBoundary(
        {
          taskNetwork: 'roomote-task-1',
          connectorName: 'connector-test',
          workerContainerName: 'worker',
          image: 'trusted-helper',
          platform: 'linux/amd64',
          controlPorts: { api: 3001, 'preview-proxy': 8081 },
        },
        runDocker,
      ),
    ).rejects.toThrow('controller-owned bootstrap network');
    expect(runDocker).toHaveBeenCalledTimes(1);
  });

  it('cleans only the owned bridge rules and leaves ordinary task networks alone', async () => {
    const runDocker = vi.fn<DockerCommand>().mockResolvedValue('');
    await removeDockerSessionEgressBoundary({ Id: networkId }, runDocker);
    expect(runDocker).not.toHaveBeenCalled();
    await removeDockerSessionEgressBoundary(
      {
        Id: networkId,
        Labels: {
          [SESSION_EGRESS_POLICY_IMAGE_LABEL]: 'trusted-helper',
          [SESSION_EGRESS_POLICY_PLATFORM_LABEL]: 'linux/amd64',
        },
      },
      runDocker,
    );
    const script = runDocker.mock.calls[0]![0].at(-1)!;
    expect(script).toContain(
      `-D DOCKER-USER -i ${bridge} -j RSE_${networkId.slice(0, 12)}`,
    );
    expect(script).not.toContain('iptables -F DOCKER-USER');
    expect(script).not.toContain('iptables -F INPUT');
    expect(script).not.toContain('iptables -P');
  });
});

describe('actual Iron connector provisioning', () => {
  it('removes the retained host boundary even when the new run has no Session grants', async () => {
    const order: string[] = [];
    const runDocker = vi.fn<DockerCommand>(async (args) => {
      order.push(args[0]!);
      if (args[0] === 'network')
        return JSON.stringify([
          {
            Id: networkId,
            Labels: {
              [SESSION_EGRESS_POLICY_IMAGE_LABEL]: 'trusted-helper',
              [SESSION_EGRESS_POLICY_PLATFORM_LABEL]: 'linux/amd64',
            },
          },
        ]);
      return '';
    });
    await resetDockerSessionEgressForResume(
      {
        workerContainerName: 'retained-worker',
        taskNetwork: 'retained-network',
        retireSource: async () => {
          order.push('retire');
        },
      },
      runDocker,
    );
    expect(order).toEqual(['retire', 'rm', 'network', 'run']);
    expect(runDocker.mock.calls.at(-1)![0].at(-1)).toContain('-D DOCKER-USER');
  });

  it('does not reopen a retained network if source retirement fails', async () => {
    const runDocker = vi.fn<DockerCommand>();
    await expect(
      resetDockerSessionEgressForResume(
        {
          workerContainerName: 'retained-worker',
          taskNetwork: 'retained-network',
          retireSource: async () => {
            throw new Error('retire failed');
          },
        },
        runDocker,
      ),
    ).rejects.toThrow('retire failed');
    expect(runDocker).not.toHaveBeenCalled();
  });

  const input = {
    workerContainerName: 'roomote-worker-1',
    taskRunId: 1,
    taskNetwork: 'roomote-task-1',
    platform: 'linux/amd64',
    image: 'pinned-iron-image',
    gatewayAddr: 'gateway:8443',
    gatewayNetwork: 'gateway-network',
    certificatePem: 'synthetic-client-certificate',
    privateKeyPem: 'synthetic-private-key-canary',
    autoRemove: true,
    logMaxSize: '10m',
    logMaxFiles: 3,
  };

  it('uses Iron connector mode and transfers private material only to the external connector', async () => {
    const runDocker = vi.fn<DockerCommand>().mockResolvedValue('');
    const name = await startDockerSessionEgressConnector(input, runDocker);
    const create = runDocker.mock.calls.find(
      ([args]) => args[0] === 'create',
    )![0];
    expect(create.slice(-4)).toEqual([
      '--entrypoint',
      '/session-egress-gateway',
      'pinned-iron-image',
      'connector',
    ]);
    expect(
      create.some(
        (arg) =>
          arg.startsWith('SESSION_EGRESS_CONNECTOR_LISTEN_ADDR=') &&
          !arg.includes('=:'),
      ),
    ).toBe(true);
    expect(
      JSON.stringify(runDocker.mock.calls.map(([args]) => args)),
    ).not.toContain(input.privateKeyPem);
    const copy = runDocker.mock.calls.find(([args]) => args[0] === 'cp')!;
    expect(copy[0]).toEqual(['cp', '-', `${name}:/`]);
    expect(copy[1]?.input?.includes(Buffer.from(input.privateKeyPem))).toBe(
      true,
    );
    expect(
      copy[1]?.input?.includes(
        Buffer.from('var/lib/roomote-connector/connector.key'),
      ),
    ).toBe(true);
    expect(runDocker.mock.calls.at(-1)![0]).toEqual(['start', name]);
  });

  it('cleans failed private-material provisioning without surfacing diagnostic contents', async () => {
    const runDocker = vi.fn<DockerCommand>(async (args) => {
      if (args[0] === 'cp') throw new Error(input.privateKeyPem);
      return '';
    });
    await expect(
      startDockerSessionEgressConnector(input, runDocker),
    ).rejects.toThrow(/^Session egress connector provisioning failed$/);
    expect(runDocker.mock.calls.at(-1)![0].slice(0, 2)).toEqual(['rm', '-f']);
    expect(runDocker.mock.calls.some(([args]) => args[0] === 'start')).toBe(
      false,
    );
  });
});
