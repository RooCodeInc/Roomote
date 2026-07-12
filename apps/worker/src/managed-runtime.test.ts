import { RunStatus } from '@roomote/types';

import { WorkerEnv } from './env';
import { closeManagedRuntime } from './managed-runtime';

describe('closeManagedRuntime', () => {
  it('closes the scoped reservation without exposing a deployment credential', async () => {
    const workerEnv = new WorkerEnv({
      systemBase: {},
      workerConfig: {
        authToken: 'roomote-run-token',
        trpcUrl: 'http://api',
        roomoteAppUrl: 'http://app',
      },
      launcherOpenCodeEnv: {
        ROOMOTE_CLOUD_SESSION_URL: 'http://cloud/',
        ROOMOTE_CLOUD_RESERVATION_ID: 'reservation-1',
        ROOMOTE_CLOUD_INFERENCE_TOKEN: 'scoped-token',
      },
    });
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ status: 'completed' }));

    await closeManagedRuntime({
      workerEnv,
      status: RunStatus.Completed,
      fetchFn,
    });

    expect(fetchFn).toHaveBeenCalledWith(
      'http://cloud/runtime/v1/sessions/reservation-1/close',
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: 'Bearer scoped-token',
        }),
        body: JSON.stringify({ outcome: 'completed', platformFault: false }),
      }),
    );
  });
});
