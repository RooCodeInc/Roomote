import { describe, expect, it, vi } from 'vitest';
import { WorkerEnv } from '../worker-env';
import { waitForSessionEgressDelivery } from '../session-egress-bootstrap';

describe('protected execution bootstrap', () => {
  it('captures the wait flag without giving setup a substitute or proxy', () => {
    const source = {
      AUTH_TOKEN: 'run-auth',
      TRPC_URL: 'http://api:3001',
      R_APP_URL: 'https://roomote.example',
      ROOMOTE_SESSION_EGRESS_BOOTSTRAP_REQUIRED: '1',
      HOME: '/sandbox',
      PATH: '/usr/bin',
    };
    const env = WorkerEnv.fromProcessEnv(source);
    expect(env.sessionEgressBootstrapRequired).toBe(true);
    expect(source).not.toHaveProperty(
      'ROOMOTE_SESSION_EGRESS_BOOTSTRAP_REQUIRED',
    );
    expect(env.buildSetupEnv()).not.toHaveProperty('HTTPS_PROXY');
    expect(env.buildSessionEgressClientEnv()).toEqual({});
    env.acceptSessionEgressDelivery({
      ROOMOTE_SESSION_EGRESS_PROXY_URL: 'http://connector:3128',
      ROOMOTE_SESSION_EGRESS_CA_FILE:
        '/etc/roomote/session-egress/ca-bundle.pem',
      ROOMOTE_SERVICE_TOKEN_EXAMPLE: `rses_${'a'.repeat(40)}`,
    });
    expect(env.buildSessionEgressClientEnv()).toMatchObject({
      HTTPS_PROXY: 'http://connector:3128',
      NODE_USE_ENV_PROXY: '1',
      ROOMOTE_SERVICE_TOKEN_EXAMPLE: `rses_${'a'.repeat(40)}`,
    });
    expect(env.buildSessionEgressClientEnv()).not.toHaveProperty('AUTH_TOKEN');
  });

  it('waits for a real delivery and fails closed on authentication failure', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce({ environment: null })
      .mockResolvedValueOnce({ environment: { READY: 'yes' } });
    await expect(
      waitForSessionEgressDelivery(read, new AbortController().signal),
    ).resolves.toEqual({ READY: 'yes' });
    expect(read).toHaveBeenCalledTimes(2);
    await expect(
      waitForSessionEgressDelivery(
        vi.fn().mockRejectedValue(new Error('denied')),
        new AbortController().signal,
      ),
    ).rejects.toThrow('denied');
  });

  it('does not begin protected execution after cancellation', async () => {
    const controller = new AbortController();
    controller.abort(new Error('run canceled'));
    const read = vi.fn();
    await expect(
      waitForSessionEgressDelivery(read, controller.signal),
    ).rejects.toThrow('run canceled');
    expect(read).not.toHaveBeenCalled();
  });
});
