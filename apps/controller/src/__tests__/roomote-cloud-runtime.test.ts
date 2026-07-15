import {
  launchRoomoteCloudCompute,
  readRoomoteCloudRuntimeConfig,
  stopRoomoteCloudCompute,
} from '../roomote-cloud-runtime';

describe('Roomote Cloud runtime', () => {
  it('stays disabled when no cloud settings are present', () => {
    expect(readRoomoteCloudRuntimeConfig({})).toBeNull();
  });

  it('rejects partial and insecure cloud settings', () => {
    expect(() =>
      readRoomoteCloudRuntimeConfig({
        ROOMOTE_CLOUD_URL: 'https://cloud.example',
      }),
    ).toThrow('config is partial');
    expect(() =>
      readRoomoteCloudRuntimeConfig({
        ROOMOTE_CLOUD_URL: 'http://cloud.example',
        ROOMOTE_CLOUD_DEPLOYMENT_TOKEN: 'deployment-token',
      }),
    ).toThrow('must use HTTPS');
  });

  it('launches managed compute without replacing BYOK model env', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        {
          id: 'lease-1',
          provider: 'roomote-cloud',
          status: 'ready',
          proxyPorts: { '4200': 4200 },
          portUrls: { '4200': 'https://sandbox.example' },
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
        { status: 201 },
      ),
    );
    const lease = await launchRoomoteCloudCompute(
      {
        baseUrl: 'https://cloud.example',
        deploymentToken: 'deployment-token',
      },
      {
        runId: 12,
        taskId: 'task-1',
        deploymentSlug: 'hosted',
        timeoutSeconds: 600,
        activeSeatCount: 3,
        environment: {
          AUTH_TOKEN: 'run-token',
          R_MODEL: 'anthropic/claude-sonnet',
          ANTHROPIC_API_KEY: 'customer-key',
        },
        ports: [4200],
      },
      fetchFn,
    );

    expect(lease).toMatchObject({
      provider: 'roomote-cloud',
      portUrls: { '4200': 'https://sandbox.example' },
    });
    const request = fetchFn.mock.calls[0];
    expect(request?.[1]).toEqual(
      expect.objectContaining({ redirect: 'manual' }),
    );
    expect(JSON.parse(String(request?.[1]?.body))).toMatchObject({
      activeSeatCount: 3,
      environment: {
        R_MODEL: 'anthropic/claude-sonnet',
        ANTHROPIC_API_KEY: 'customer-key',
      },
    });
  });

  it('stops a managed lease using the deployment credential', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ id: 'lease-1', status: 'stopped' }));

    await stopRoomoteCloudCompute(
      {
        baseUrl: 'https://cloud.example',
        deploymentToken: 'deployment-token',
      },
      'lease-1',
      fetchFn,
    );

    expect(fetchFn).toHaveBeenCalledWith(
      'https://cloud.example/runtime/v1/compute/leases/lease-1/stop',
      expect.objectContaining({
        method: 'POST',
        redirect: 'manual',
        headers: expect.objectContaining({
          authorization: 'Bearer deployment-token',
        }),
      }),
    );
  });
});
