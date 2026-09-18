import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createComputeProviderClient } from '../factory';
import type { AzureConfig } from '../types';

const SANDBOX_ID = '11111111-2222-3333-4444-555555555555';
const REGION = 'canadacentral';
const ENDPOINT = `https://management.${REGION}.azuredevcompute.io`;
const GROUP_PATH =
  '/subscriptions/sub-1/resourceGroups/rg-1/sandboxGroups/group-1';

interface RecordedRequest {
  method: string;
  url: string;
  body?: unknown;
  binaryBody?: Uint8Array;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function createFetchMock(options: {
  states?: string[];
  onRequest?: (request: RecordedRequest) => Response | undefined;
}) {
  const requests: RecordedRequest[] = [];
  let stateIndex = 0;
  const states = options.states ?? ['Running'];

  const fetchImpl = vi.fn(
    async (
      url: string,
      init?: { method?: string; headers?: unknown; body?: unknown },
    ): Promise<Response> => {
      const method = init?.method ?? 'GET';
      const recorded: RecordedRequest = {
        method,
        url,
        body:
          typeof init?.body === 'string'
            ? (JSON.parse(init.body) as unknown)
            : undefined,
        binaryBody: init?.body instanceof Uint8Array ? init.body : undefined,
      };
      requests.push(recorded);

      const override = options.onRequest?.(recorded);
      if (override) return override;

      const sbxPath = `${GROUP_PATH}/sandboxes/${SANDBOX_ID}`;

      if (method === 'PUT' && url.includes(`${GROUP_PATH}/sandboxes?`)) {
        return jsonResponse({ id: SANDBOX_ID, state: 'Creating' });
      }
      if (method === 'GET' && url.startsWith(`${ENDPOINT}${sbxPath}/files`)) {
        return jsonResponse({ title: 'NotFound' }, 404);
      }
      if (method === 'GET' && url.startsWith(`${ENDPOINT}${sbxPath}/stats`)) {
        return jsonResponse({
          cpu: { user: 50, system: 20 },
          network: { rxBytes: 1000, txBytes: 2000 },
        });
      }
      if (method === 'GET' && url.startsWith(`${ENDPOINT}${sbxPath}?`)) {
        const state = states[Math.min(stateIndex, states.length - 1)];
        stateIndex += 1;
        return jsonResponse({
          id: SANDBOX_ID,
          state,
          createdAt: '2026-07-28T17:50:24Z',
        });
      }
      if (method === 'POST' && url.includes('/executeShellCommand')) {
        return jsonResponse({ exitCode: 0, stdout: 'ok', stderr: '' });
      }
      if (method === 'POST' && url.includes('/snapshot')) {
        return jsonResponse({
          id: 'snap-1',
          sandboxId: SANDBOX_ID,
          createdAtUtc: '2026-07-28T18:00:00Z',
        });
      }
      if (method === 'GET' && url.includes(`${GROUP_PATH}/snapshots?`)) {
        return jsonResponse({
          value: [
            {
              id: 'snap-1',
              sandboxId: SANDBOX_ID,
              createdAtUtc: '2026-07-28T18:00:00Z',
            },
          ],
        });
      }
      if (method === 'GET' && url.includes(`${GROUP_PATH}/sandboxes?`)) {
        return jsonResponse({ value: [] });
      }
      if (method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      // ports/add, stop, resume, lifecycle, etc.
      return jsonResponse({});
    },
  );

  return { fetchImpl: fetchImpl as unknown as typeof fetch, requests };
}

function createClient(
  fetchImpl: typeof fetch,
  overrides: Partial<AzureConfig> = {},
): ReturnType<typeof createComputeProviderClient> {
  const config: AzureConfig = {
    subscriptionId: 'sub-1',
    resourceGroup: 'rg-1',
    sandboxGroup: 'group-1',
    region: REGION,
    diskImage: 'disk-image-1',
    timeoutMs: 3_600_000,
    tokenProvider: { getToken: async () => 'test-token' },
    fetchImpl,
    ...overrides,
  };
  return createComputeProviderClient({ provider: 'azure', config });
}

describe('azure adapter contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates an instance, waits for Running, and exposes deterministic port domains', async () => {
    const { fetchImpl, requests } = createFetchMock({});
    const client = createClient(fetchImpl);

    const created = await client.createInstance({
      ports: [3000],
      tags: { app_environment: 'env-1' },
    });

    expect(created.instanceId).toBe(SANDBOX_ID);
    expect(created.status).toBe('running');
    expect(created.domains?.['3000']).toBe(
      `https://${SANDBOX_ID}--3000.${REGION}.adcproxy.io`,
    );

    const put = requests.find(
      (r) => r.method === 'PUT' && r.url.includes('/sandboxes?'),
    );
    expect(put?.body).toMatchObject({
      sourcesRef: { diskImage: { id: 'disk-image-1' } },
      resources: { cpu: '1000m', memory: '2048Mi' },
      lifecycle: {
        autoSuspendPolicy: { enabled: true, interval: 3600, mode: 'Memory' },
        // Backstop floors to 30d (suspension-anchored TTL); the 3600s
        // task timeout stays Roomote-side.
        autoDeletePolicy: { enabled: true, deleteIntervalInSeconds: 2592000 },
      },
      egressPolicy: { defaultAction: 'Allow', trafficInspection: 'Partial' },
      labels: { app_environment: 'env-1' },
    });

    const portAdd = requests.find((r) => r.url.includes('/ports/add'));
    expect(portAdd?.body).toMatchObject({
      port: 3000,
      auth: { anonymous: true },
      // Manual activation: wake stays deliberate; OnDemand wakes orphaned
      // standby sandboxes on any inbound traffic.
      activationMode: 'Manual',
    });
  });

  it.each([
    { config: { timeoutMs: undefined }, seconds: 18_000 },
    { config: { timeoutMs: 3_600_001 }, seconds: 3601 },
    { config: { autoSuspendSeconds: 900 }, seconds: 900 },
    { config: { autoSuspendSeconds: 0 }, seconds: 0 },
  ])('sets the idle fallback for $config', async ({ config, seconds }) => {
    const { fetchImpl, requests } = createFetchMock({});
    await createClient(fetchImpl, config).createInstance({});
    expect(requests.find((r) => r.method === 'PUT')?.body).toMatchObject({
      lifecycle: {
        autoSuspendPolicy: {
          enabled: seconds > 0,
          interval: seconds,
          mode: 'Memory',
        },
      },
    });
  });

  it.each([
    { timeoutMs: 0 },
    { timeoutMs: Number.NaN },
    { timeoutMs: Number.POSITIVE_INFINITY },
    { autoSuspendSeconds: -1 },
    { autoSuspendSeconds: 0.5 },
  ])(
    'rejects invalid lifecycle settings before creation: %j',
    async (config) => {
      const { fetchImpl, requests } = createFetchMock({});
      await expect(
        createClient(fetchImpl, config).createInstance({}),
      ).rejects.toThrow('Azure requires a positive timeout');
      expect(requests).toHaveLength(0);
    },
  );

  it('refreshes the idle fallback when reusing an idempotent launch', async () => {
    const { fetchImpl, requests } = createFetchMock({
      onRequest: (request) =>
        request.method === 'GET' && request.url.includes('/sandboxes?')
          ? jsonResponse([
              {
                id: SANDBOX_ID,
                state: 'Running',
                labels: { 'roomote-idempotency-key': 'launch-1' },
                lifecycle: { autoSuspendPolicy: { enabled: false } },
              },
            ])
          : undefined,
    });
    await createClient(fetchImpl).createInstance({
      idempotencyKey: 'launch-1',
      ports: [3000],
    });
    expect(requests.some((r) => r.method === 'PUT')).toBe(false);
    const lifecycleIndex = requests.findIndex((r) =>
      r.url.includes('/lifecycle'),
    );
    expect(requests[lifecycleIndex]?.body).toMatchObject({
      autoSuspendPolicy: { enabled: true, interval: 3600, mode: 'Memory' },
    });
    expect(
      requests.findIndex((r) => r.url.includes('/ports/add')),
    ).toBeGreaterThan(lifecycleIndex);
  });

  it('does not round small tier cpus up to whole cores', async () => {
    const { fetchImpl, requests } = createFetchMock({});
    const client = createComputeProviderClient({
      provider: 'azure',
      config: {
        subscriptionId: 'sub-1',
        resourceGroup: 'rg-1',
        sandboxGroup: 'group-1',
        region: REGION,
        diskImage: 'disk-image-1',
        cpuMillicores: 250,
        memoryMiB: 512,
        tokenProvider: { getToken: async () => 'test-token' },
        fetchImpl,
      },
    });

    await client.createInstance({});

    const put = requests.find(
      (r) => r.method === 'PUT' && r.url.includes('/sandboxes?'),
    );
    expect(put?.body).toMatchObject({
      resources: { cpu: '250m', memory: '512Mi' },
    });
  });

  it('scales cpu to satisfy the ACA cores×2Gi memory tier cap', async () => {
    const { fetchImpl, requests } = createFetchMock({});
    const client = createComputeProviderClient({
      provider: 'azure',
      config: {
        subscriptionId: 'sub-1',
        resourceGroup: 'rg-1',
        sandboxGroup: 'group-1',
        region: REGION,
        diskImage: 'disk-image-1',
        memoryMiB: 4096,
        tokenProvider: { getToken: async () => 'test-token' },
        fetchImpl,
      },
    });

    await client.createInstance({});

    const put = requests.find(
      (r) => r.method === 'PUT' && r.url.includes('/sandboxes?'),
    );
    expect(put?.body).toMatchObject({
      resources: { cpu: '2000m', memory: '4096Mi' },
    });
  });

  it('treats a 409 PortAlreadyExists as success when exposing ports', async () => {
    const { fetchImpl } = createFetchMock({
      onRequest: (request) =>
        request.url.includes('/ports/add')
          ? jsonResponse({ title: 'PortAlreadyExists' }, 409)
          : undefined,
    });
    const client = createClient(fetchImpl);

    const result = await client.getInstanceDomains!({
      instanceId: SANDBOX_ID,
      ports: [8080],
    });
    expect(result.domains['8080']).toContain('--8080.');
  });

  it('migrates a legacy OnDemand port to Manual activation on conflict', async () => {
    let addAttempts = 0;
    const { fetchImpl, requests } = createFetchMock({
      onRequest: (request) => {
        if (request.url.includes('/ports/add')) {
          addAttempts += 1;
          // The legacy add conflicts; the post-remove re-add succeeds.
          if (addAttempts === 1) {
            return jsonResponse({ title: 'PortAlreadyExists' }, 409);
          }
          return jsonResponse({});
        }
        if (
          request.method === 'GET' &&
          request.url.includes(`${SANDBOX_ID}?`)
        ) {
          return jsonResponse({
            id: SANDBOX_ID,
            state: 'Running',
            ports: [
              {
                port: 8080,
                auth: { anonymous: true },
                activationMode: 'OnDemand',
              },
            ],
          });
        }
        return undefined;
      },
    });
    const client = createClient(fetchImpl);

    const result = await client.getInstanceDomains!({
      instanceId: SANDBOX_ID,
      ports: [8080],
    });

    expect(result.domains['8080']).toContain('--8080.');
    const portRemove = requests.find((r) => r.url.includes('/ports/remove'));
    expect(portRemove?.body).toMatchObject({ port: 8080 });
    const portAdds = requests.filter((r) => r.url.includes('/ports/add'));
    expect(portAdds).toHaveLength(2);
    expect(portAdds[1]?.body).toMatchObject({
      port: 8080,
      auth: { anonymous: true },
      activationMode: 'Manual',
    });
  });

  it('leaves an existing Manual port untouched on conflict', async () => {
    const { fetchImpl, requests } = createFetchMock({
      onRequest: (request) => {
        if (request.url.includes('/ports/add')) {
          return jsonResponse({ title: 'PortAlreadyExists' }, 409);
        }
        if (
          request.method === 'GET' &&
          request.url.includes(`${SANDBOX_ID}?`)
        ) {
          return jsonResponse({
            id: SANDBOX_ID,
            state: 'Running',
            ports: [
              {
                port: 8080,
                auth: { anonymous: true },
                activationMode: 'Manual',
              },
            ],
          });
        }
        return undefined;
      },
    });
    const client = createClient(fetchImpl);

    await client.getInstanceDomains!({
      instanceId: SANDBOX_ID,
      ports: [8080],
    });

    expect(requests.some((r) => r.url.includes('/ports/remove'))).toBe(false);
    expect(requests.filter((r) => r.url.includes('/ports/add'))).toHaveLength(
      1,
    );
  });

  it('runs a blocking command with cwd and returns output', async () => {
    const { fetchImpl, requests } = createFetchMock({});
    const client = createClient(fetchImpl);

    const result = await client.runCommand({
      instanceId: SANDBOX_ID,
      cmd: 'echo',
      args: ['hello world'],
      cwd: '/sandbox',
      env: { FOO: 'bar' },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('ok');

    const exec = requests.find((r) => r.url.includes('/executeShellCommand'));
    expect(exec?.body).toMatchObject({ workingDirectory: '/sandbox' });
    const command = (exec?.body as { command: string }).command;
    expect(command).toContain('env FOO=bar');
    expect(command).toContain("echo 'hello world'");
  });

  it('launches detached commands with log + exit-sentinel redirection', async () => {
    const { fetchImpl, requests } = createFetchMock({});
    const client = createClient(fetchImpl);

    const result = await client.runCommand({
      instanceId: SANDBOX_ID,
      cmd: 'node',
      args: ['/sandbox/worker.js'],
      detached: true,
    });

    expect(result.commandId).toMatch(/^azc-/);
    expect(result.exitCode).toBeNull();

    const exec = requests.find((r) => r.url.includes('/executeShellCommand'));
    const command = (exec?.body as { command: string }).command;
    expect(command).toContain('nohup bash -c');
    expect(command).toContain('.stdout.log');
    expect(command).toContain('.stderr.log');
    expect(command).toContain('.exit');
  }, 10_000);

  it('reads detached command output from log files', async () => {
    const { fetchImpl } = createFetchMock({
      onRequest: (request) => {
        if (
          request.url.includes('/files') &&
          request.url.includes('.stdout.log')
        ) {
          return new Response('line-1\nline-2\n', { status: 200 });
        }
        if (request.url.includes('/files') && request.url.includes('.exit')) {
          return new Response('0', { status: 200 });
        }
        return undefined;
      },
    });
    const client = createClient(fetchImpl);

    const output = await client.getCommandOutput({
      instanceId: SANDBOX_ID,
      commandId: 'azc-test',
    });
    expect(output).toBe('line-1\nline-2\n');

    const events: { stream: string; data: string }[] = [];
    for await (const event of client.streamCommandOutput({
      instanceId: SANDBOX_ID,
      commandId: 'azc-test',
    })) {
      events.push(event);
    }
    expect(events).toEqual([{ stream: 'stdout', data: 'line-1\nline-2\n' }]);
  });

  it('writes files as octet-stream with createDirs', async () => {
    const { fetchImpl, requests } = createFetchMock({});
    const client = createClient(fetchImpl);

    await client.writeFiles({
      instanceId: SANDBOX_ID,
      files: [
        {
          path: '/sandbox/.roomote/bootstrap.sh',
          content: Buffer.from('#!/bin/bash\n'),
        },
      ],
    });

    const put = requests.find(
      (r) => r.method === 'PUT' && r.url.includes('/files'),
    );
    expect(put?.url).toContain('createDirs=true');
    expect(put?.binaryBody).toBeDefined();
    expect(Buffer.from(put!.binaryBody!).toString()).toBe('#!/bin/bash\n');
  });

  it('maps sandbox states to ComputeInstanceStatus', async () => {
    const { fetchImpl } = createFetchMock({ states: ['Suspended'] });
    const client = createClient(fetchImpl);
    const status = await client.getInstanceStatus({ instanceId: SANDBOX_ID });
    expect(status.status).toBe('stopped');
  });

  it('reports no provider deadline while a sandbox is Running', async () => {
    const { fetchImpl } = createFetchMock({
      states: ['Running'],
      onRequest: (request) =>
        request.method === 'GET' && request.url.includes(`${SANDBOX_ID}?`)
          ? jsonResponse({
              id: SANDBOX_ID,
              state: 'Running',
              createdAt: '2026-07-01T00:00:00Z',
              lifecycle: {
                autoDeletePolicy: {
                  enabled: true,
                  deleteIntervalInSeconds: 2_592_000,
                },
              },
            })
          : undefined,
    });
    const client = createClient(fetchImpl);

    const status = await client.getInstanceStatus({ instanceId: SANDBOX_ID });
    expect(status.status).toBe('running');
    // Auto-delete never fires on Running sandboxes (suspension-anchored),
    // so no deadline is reported — even with an auto-delete policy present.
    expect(status.timeoutRemainingMs).toBeUndefined();
  });

  it('reports the suspension-anchored deadline for a stopped sandbox', async () => {
    const stoppedAt = new Date(Date.now() - 60_000).toISOString();
    const { fetchImpl } = createFetchMock({
      onRequest: (request) =>
        request.method === 'GET' && request.url.includes(`${SANDBOX_ID}?`)
          ? jsonResponse({
              id: SANDBOX_ID,
              state: 'Stopped',
              createdAt: '2026-07-01T00:00:00Z',
              stateDetails: { stoppedReason: 'UserStopped', stoppedAt },
              lifecycle: {
                autoDeletePolicy: {
                  enabled: true,
                  deleteIntervalInSeconds: 2_592_000,
                },
              },
            })
          : undefined,
    });
    const client = createClient(fetchImpl);

    const status = await client.getInstanceStatus({ instanceId: SANDBOX_ID });
    expect(status.status).toBe('stopped');
    // remaining = stoppedAt + 30d - now ≈ 30d - 60s
    expect(status.timeoutRemainingMs).toBeGreaterThan(
      2_592_000_000 - 5 * 60_000,
    );
    expect(status.timeoutRemainingMs).toBeLessThanOrEqual(2_592_000_000);
  });

  it('omits the deadline when the timestamp is malformed instead of leaking NaN', async () => {
    const { fetchImpl } = createFetchMock({
      onRequest: (request) =>
        request.method === 'GET' && request.url.includes(`${SANDBOX_ID}?`)
          ? jsonResponse({
              id: SANDBOX_ID,
              state: 'Stopped',
              createdAt: '2026-07-01T00:00:00Z',
              stateDetails: {
                stoppedReason: 'UserStopped',
                stoppedAt: 'not-a-date',
              },
              lifecycle: {
                autoDeletePolicy: {
                  enabled: true,
                  deleteIntervalInSeconds: 2_592_000,
                },
              },
            })
          : undefined,
    });
    const client = createClient(fetchImpl);

    const status = await client.getInstanceStatus({ instanceId: SANDBOX_ID });
    expect(status.status).toBe('stopped');
    expect(status.timeoutRemainingMs).toBeUndefined();
  });

  it('omits the deadline for a stopped sandbox without stateDetails', async () => {
    const { fetchImpl } = createFetchMock({
      onRequest: (request) =>
        request.method === 'GET' && request.url.includes(`${SANDBOX_ID}?`)
          ? jsonResponse({
              id: SANDBOX_ID,
              state: 'Stopped',
              createdAt: '2026-07-01T00:00:00Z',
              lifecycle: {
                autoDeletePolicy: {
                  enabled: true,
                  deleteIntervalInSeconds: 2_592_000,
                },
              },
            })
          : undefined,
    });
    const client = createClient(fetchImpl);

    const status = await client.getInstanceStatus({ instanceId: SANDBOX_ID });
    expect(status.status).toBe('stopped');
    // Legacy stopped documents have no trustworthy suspension anchor —
    // omit rather than derive a phantom expiry from createdAt.
    expect(status.timeoutRemainingMs).toBeUndefined();
  });

  it('creates a snapshot synchronously, persists the id before teardown, then deletes the sandbox', async () => {
    const { fetchImpl, requests } = createFetchMock({});
    const client = createClient(fetchImpl);
    const callOrder: string[] = [];

    const result = await client.createSnapshot({
      instanceId: SANDBOX_ID,
      onSnapshotCreated: async () => {
        callOrder.push('persist');
        const deletedBeforePersist = requests.some(
          (r) => r.method === 'DELETE' && r.url.includes(SANDBOX_ID),
        );
        expect(deletedBeforePersist).toBe(false);
      },
    });

    expect(result.snapshotId).toBe('snap-1');
    expect(
      requests.some((r) => r.method === 'DELETE' && r.url.includes(SANDBOX_ID)),
    ).toBe(true);
    expect(result.usageObservation?.activeCpuDurationMs).toBe(700);
    expect(result.usageObservation?.networkTransfer).toEqual({
      ingress: 1000,
      egress: 2000,
    });

    // Closed detached commands' logs are purged before the snapshot so they
    // don't ride into restored sandboxes (in-flight command's files stay).
    const execIndex = requests.findIndex((r) =>
      r.url.includes('/executeShellCommand'),
    );
    const snapshotIndex = requests.findIndex((r) =>
      r.url.includes('/snapshot'),
    );
    expect(execIndex).toBeGreaterThanOrEqual(0);
    expect(snapshotIndex).toBeGreaterThan(execIndex);
    const purgeCommand = (requests[execIndex]?.body as { command: string })
      .command;
    expect(purgeCommand).toContain('find');
    expect(purgeCommand).toContain("-name '*.exit'");
  });

  it('finds snapshots by source instance', async () => {
    const { fetchImpl } = createFetchMock({});
    const client = createClient(fetchImpl);

    const found = await client.findSnapshotBySourceInstance?.({
      instanceId: SANDBOX_ID,
    });
    expect(found?.snapshotId).toBe('snap-1');
    expect(found?.sourceInstanceId).toBe(SANDBOX_ID);
  });

  it('resumes from a snapshot and re-adds ports', async () => {
    const { fetchImpl, requests } = createFetchMock({});
    const client = createClient(fetchImpl);

    const resumed = await client.resumeFromSnapshot({
      sourceSnapshotId: 'snap-1',
      ports: [3000],
    });

    expect(resumed.instanceId).toBe(SANDBOX_ID);
    expect(resumed.sourceSnapshotId).toBe('snap-1');
    expect(resumed.domains?.['3000']).toContain('--3000.');

    const put = requests.find(
      (r) => r.method === 'PUT' && r.url.includes('/sandboxes?'),
    );
    expect(put?.body).toMatchObject({
      sourcesRef: { snapshot: { id: 'snap-1' } },
    });
    expect(put?.body).not.toHaveProperty('lifecycle');
    const lifecycleIndex = requests.findIndex((r) =>
      r.url.includes('/lifecycle'),
    );
    expect(requests[lifecycleIndex]?.body).toMatchObject({
      autoSuspendPolicy: { enabled: true, interval: 3600, mode: 'Memory' },
    });
    expect(
      requests.findIndex((r) => r.url.includes('/ports/add')),
    ).toBeGreaterThan(lifecycleIndex);
    expect(requests.some((r) => r.url.includes('/ports/add'))).toBe(true);
  });

  it('refreshes lifecycle after a legacy unlabeled snapshot restore', async () => {
    const { fetchImpl, requests } = createFetchMock({
      onRequest: (request) =>
        request.method === 'PUT' &&
        request.url.includes('/sandboxes?') &&
        (request.body as { labels?: unknown })?.labels
          ? jsonResponse(
              { title: 'InvalidRequest', detail: 'Labels not supported' },
              400,
            )
          : undefined,
    });
    await createClient(fetchImpl).resumeFromSnapshot({
      sourceSnapshotId: 'snap-1',
      tags: { app_environment: 'development' },
    });
    expect(requests.filter((r) => r.method === 'PUT')).toHaveLength(2);
    expect(
      requests.find((r) => r.url.includes('/lifecycle'))?.body,
    ).toMatchObject({
      autoSuspendPolicy: { enabled: true, interval: 3600 },
    });
  });

  it('cleans up a restored clone if lifecycle installation fails without retrying the restore', async () => {
    const { fetchImpl, requests } = createFetchMock({
      onRequest: (request) =>
        request.url.includes('/lifecycle')
          ? jsonResponse(
              { title: 'InvalidPolicy', detail: 'Policy rejected' },
              400,
            )
          : undefined,
    });
    await expect(
      createClient(fetchImpl).resumeFromSnapshot({
        sourceSnapshotId: 'snap-1',
        tags: { app_environment: 'development' },
        ports: [3000],
      }),
    ).rejects.toThrow('Policy rejected');
    expect(requests.filter((r) => r.method === 'PUT')).toHaveLength(1);
    expect(
      requests.some((r) => r.method === 'DELETE' && r.url.includes(SANDBOX_ID)),
    ).toBe(true);
    expect(requests.some((r) => r.url.includes('/ports/add'))).toBe(false);
  });

  it('enters standby via stop and resumes via resume', async () => {
    const { fetchImpl, requests } = createFetchMock({
      // stop-poll, resume pre-check, post-resume poll
      states: ['Stopped', 'Stopped', 'Running'],
    });
    const client = createClient(fetchImpl);

    const standby = await client.enterStandby?.({ instanceId: SANDBOX_ID });
    expect(standby?.resumeHandle).toBe(SANDBOX_ID);
    expect(requests.some((r) => r.url.includes('/stop'))).toBe(true);
    expect(standby?.usageObservation?.activeCpuDurationMs).toBe(700);

    const resumed = await client.resumeFromStandby?.({
      resumeHandle: SANDBOX_ID,
      ports: [3000],
    });
    expect(resumed?.instanceId).toBe(SANDBOX_ID);
    expect(resumed?.status).toBe('running');
    expect(requests.some((r) => r.url.includes('/resume'))).toBe(true);

    const lifecycleIndex = requests.findIndex((r) =>
      r.url.includes('/lifecycle'),
    );
    expect(requests[lifecycleIndex]?.body).toMatchObject({
      autoSuspendPolicy: { enabled: true, interval: 3600, mode: 'Memory' },
      autoDeletePolicy: { enabled: true, deleteIntervalInSeconds: 2592000 },
    });
    expect(
      requests.findIndex((r) => r.url.includes('/resume')),
    ).toBeGreaterThan(lifecycleIndex);
  });

  it('does not resume a retained sandbox if lifecycle installation fails', async () => {
    const { fetchImpl, requests } = createFetchMock({
      states: ['Stopped'],
      onRequest: (request) =>
        request.url.includes('/lifecycle')
          ? jsonResponse(
              { title: 'InvalidPolicy', detail: 'Policy rejected' },
              400,
            )
          : undefined,
    });
    await expect(
      createClient(fetchImpl).resumeFromStandby?.({ resumeHandle: SANDBOX_ID }),
    ).rejects.toThrow('Policy rejected');
    expect(requests.some((r) => r.url.includes('/resume'))).toBe(false);
    expect(requests.some((r) => r.method === 'DELETE')).toBe(false);
  });

  it('refreshes an already-running standby while preserving its deletion policy when no timeout is configured', async () => {
    const autoDeletePolicy = {
      enabled: true,
      deleteIntervalInSeconds: 3_456_000,
    };
    const { fetchImpl, requests } = createFetchMock({
      onRequest: (request) =>
        request.method === 'GET' && request.url.includes(`${SANDBOX_ID}?`)
          ? jsonResponse({
              id: SANDBOX_ID,
              state: 'Running',
              lifecycle: {
                autoDeletePolicy,
                autoSuspendPolicy: { enabled: false },
              },
            })
          : undefined,
    });
    await createClient(fetchImpl, { timeoutMs: undefined }).resumeFromStandby?.(
      { resumeHandle: SANDBOX_ID },
    );
    expect(requests.find((r) => r.url.includes('/lifecycle'))?.body).toEqual({
      autoDeletePolicy,
      autoSuspendPolicy: { enabled: true, interval: 18_000, mode: 'Memory' },
    });
    expect(requests.some((r) => r.url.includes('/resume'))).toBe(false);
  });

  it('accepts a concurrent stop only after confirming the sandbox is stopped', async () => {
    const { fetchImpl } = createFetchMock({
      states: ['Stopped'],
      onRequest: (request) =>
        request.url.includes('/stop?')
          ? jsonResponse(
              { title: 'SandboxNotRunning', detail: 'Not running' },
              409,
            )
          : undefined,
    });
    await expect(
      createClient(fetchImpl).enterStandby?.({ instanceId: SANDBOX_ID }),
    ).resolves.toMatchObject({ resumeHandle: SANDBOX_ID });
  });

  it.each(['Running', 'Failed', 'Deleting'])(
    'does not report a successful suspension when stop conflicts and GET says %s',
    async (state) => {
      const { fetchImpl } = createFetchMock({
        states: [state],
        onRequest: (request) =>
          request.url.includes('/stop?')
            ? jsonResponse(
                { title: 'SandboxNotRunning', detail: 'Not running' },
                409,
              )
            : undefined,
      });
      await expect(
        createClient(fetchImpl).enterStandby?.({ instanceId: SANDBOX_ID }),
      ).rejects.toMatchObject({ status: 409, code: 'SandboxNotRunning' });
    },
  );

  it('does not swallow unrelated stop conflicts', async () => {
    const { fetchImpl } = createFetchMock({
      states: ['Stopped'],
      onRequest: (request) =>
        request.url.includes('/stop?')
          ? jsonResponse({ title: 'AnotherConflict', detail: 'Conflict' }, 409)
          : undefined,
    });
    await expect(
      createClient(fetchImpl).enterStandby?.({ instanceId: SANDBOX_ID }),
    ).rejects.toMatchObject({ code: 'AnotherConflict' });
  });

  it('destroys an instance and reports usage', async () => {
    const { fetchImpl, requests } = createFetchMock({});
    const client = createClient(fetchImpl);

    const result = await client.destroyInstance({ instanceId: SANDBOX_ID });
    expect(
      requests.some((r) => r.method === 'DELETE' && r.url.includes(SANDBOX_ID)),
    ).toBe(true);
    expect(result.usageObservation?.networkTransfer?.egress).toBe(2000);
  });

  it('lists instances', async () => {
    const { fetchImpl } = createFetchMock({
      onRequest: (request) =>
        request.method === 'GET' && request.url.includes('/sandboxes?')
          ? jsonResponse({
              value: [
                { id: 'a', state: 'Running' },
                { id: 'b', state: 'Creating' },
              ],
            })
          : undefined,
    });
    const client = createClient(fetchImpl);

    const instances = await client.listInstances({});
    expect(instances).toEqual([
      expect.objectContaining({ instanceId: 'a', status: 'running' }),
      expect.objectContaining({ instanceId: 'b', status: 'pending' }),
    ]);
  });
});
