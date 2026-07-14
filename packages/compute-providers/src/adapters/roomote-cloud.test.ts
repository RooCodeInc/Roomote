import { RoomoteCloudClient } from './roomote-cloud';

describe('RoomoteCloudClient', () => {
  it('reads lease status using the deployment credential', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        id: 'lease-1',
        status: 'running',
        timeoutRemainingMs: 30_000,
      }),
    );
    const client = new RoomoteCloudClient({
      baseUrl: 'https://cloud.example/',
      deploymentToken: 'deployment-token',
      fetchFn,
    });

    await expect(
      client.getInstanceStatus({ instanceId: 'lease-1' }),
    ).resolves.toEqual({ status: 'running', timeoutRemainingMs: 30_000 });
    expect(fetchFn).toHaveBeenCalledWith(
      'https://cloud.example/runtime/v1/compute/leases/lease-1',
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: 'Bearer deployment-token',
        }),
      }),
    );
  });

  it('stops a lease by its opaque Roomote Cloud lease id', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ id: 'lease-1', status: 'stopped' }));
    const client = new RoomoteCloudClient({
      baseUrl: 'https://cloud.example',
      deploymentToken: 'deployment-token',
      fetchFn,
    });

    await expect(
      client.destroyInstance({ instanceId: 'lease-1' }),
    ).resolves.toEqual({});
    expect(fetchFn).toHaveBeenCalledWith(
      'https://cloud.example/runtime/v1/compute/leases/lease-1/stop',
      expect.objectContaining({ method: 'POST', body: '{}' }),
    );
  });
});
