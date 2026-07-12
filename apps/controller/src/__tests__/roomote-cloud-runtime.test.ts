import {
  acquireRoomoteCloudRuntime,
  launchRoomoteCloudCompute,
  readRoomoteCloudRuntimeConfig,
} from '../roomote-cloud-runtime';

describe('Roomote Cloud runtime', () => {
  it('stays disabled when no cloud settings are present', () => {
    expect(readRoomoteCloudRuntimeConfig({})).toBeNull();
  });

  it('rejects partial cloud settings', () => {
    expect(() =>
      readRoomoteCloudRuntimeConfig({ ROOMOTE_CLOUD_URL: 'http://cloud' }),
    ).toThrow('config is partial');
  });

  it('acquires a scoped session and returns worker-only inference env', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        {
          reservationId: 'reservation-1',
          token: 'scoped-token',
          expiresInSeconds: 3600,
          inference: {
            baseUrl: 'http://cloud/inference/v1',
            defaultModel: 'roomote/default',
            availableModels: ['roomote/default'],
          },
        },
        { status: 201 },
      ),
    );

    const result = await acquireRoomoteCloudRuntime(
      {
        baseUrl: 'http://cloud',
        deploymentToken: 'deployment-token',
      },
      { taskId: 'task-1', runId: 12, expiresInSeconds: 3600 },
      fetchFn,
    );

    expect(result).toEqual({
      reservationId: 'reservation-1',
      workerEnv: {
        R_MODEL: 'roomote/default',
        R_SMALL_MODEL: 'roomote/default',
        ROOMOTE_CLOUD_INFERENCE_BASE_URL: 'http://cloud/inference/v1',
        ROOMOTE_CLOUD_INFERENCE_TOKEN: 'scoped-token',
        ROOMOTE_CLOUD_SESSION_URL: 'http://cloud',
        ROOMOTE_CLOUD_RESERVATION_ID: 'reservation-1',
      },
    });
    expect(fetchFn).toHaveBeenCalledWith(
      'http://cloud/runtime/v1/sessions',
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: 'Bearer deployment-token',
        }),
      }),
    );
  });

  it('launches managed compute with the deployment credential', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        {
          id: 'lease-1',
          provider: 'docker',
          machineId: 'container-1',
          status: 'ready',
          proxyPorts: { '4200': 49152 },
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
        { status: 201 },
      ),
    );
    const lease = await launchRoomoteCloudCompute(
      {
        baseUrl: 'http://cloud',
        deploymentToken: 'deployment-token',
      },
      {
        runId: 12,
        taskId: 'task-1',
        deploymentSlug: 'hosted',
        timeoutSeconds: 600,
        environment: { AUTH_TOKEN: 'run-token' },
        ports: [4200],
      },
      fetchFn,
    );
    expect(lease.proxyPorts['4200']).toBe(49152);
    expect(fetchFn).toHaveBeenCalledWith(
      'http://cloud/runtime/v1/compute/leases',
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: 'Bearer deployment-token',
        }),
      }),
    );
  });
});
