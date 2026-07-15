import type { AddressInfo } from 'node:net';

import type { Redis } from '@roomote/redis';

import { GatewayStatusStore, startHealthServer } from './status';

function mockRedis(): Redis {
  return { set: vi.fn().mockResolvedValue('OK') } as unknown as Redis;
}

describe('gateway health', () => {
  it('requires leadership, Discord connectivity, and API forwarding', async () => {
    const status = new GatewayStatusStore(mockRedis(), 30);
    await status.update({
      leader: true,
      configured: true,
      connected: true,
      forwardingReady: false,
    });
    expect(status.get().ready).toBe(false);

    await status.update({ forwardingReady: true });
    expect(status.get().ready).toBe(true);
  });

  it('serves liveness separately from readiness', async () => {
    const status = new GatewayStatusStore(mockRedis(), 30);
    const server = startHealthServer(0, () => status.get());
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      await expect(
        fetch(`http://127.0.0.1:${port}/health/liveness`),
      ).resolves.toMatchObject({ status: 200 });
      await expect(
        fetch(`http://127.0.0.1:${port}/health/readiness`),
      ).resolves.toMatchObject({ status: 503 });
    } finally {
      server.close();
    }
  });
});
