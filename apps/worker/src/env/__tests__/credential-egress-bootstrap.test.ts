import { describe, expect, it, vi } from 'vitest';
import { WorkerEnv } from '../worker-env';
import { waitForCredentialEgressDelivery } from '../credential-egress-bootstrap';

describe('protected execution bootstrap', () => {
  it('captures the wait flag without giving setup a substitute or proxy', () => {
    const source = {
      AUTH_TOKEN: 'run-auth',
      TRPC_URL: 'http://api:3001',
      R_APP_URL: 'https://roomote.example',
      ROOMOTE_CREDENTIAL_EGRESS_BOOTSTRAP_REQUIRED: '1',
      HOME: '/sandbox',
      PATH: '/usr/bin',
    };
    const env = WorkerEnv.fromProcessEnv(source);
    expect(env.credentialEgressBootstrapRequired).toBe(true);
    expect(source).not.toHaveProperty(
      'ROOMOTE_CREDENTIAL_EGRESS_BOOTSTRAP_REQUIRED',
    );
    expect(env.buildSetupEnv()).not.toHaveProperty('ROOMOTE_SERVICE_BASE_URL');
    expect(env.buildCredentialEgressClientEnv()).toEqual({});
    env.acceptCredentialEgressDelivery({
      ROOMOTE_SERVICE_BASE_URL: 'https://api.example.com/api/credential-egress',
      ROOMOTE_CREDENTIAL_EGRESS_SERVICES: '[]',
      ROOMOTE_SERVICE_TOKEN_EXAMPLE: `rses_${'a'.repeat(40)}`,
    });
    expect(env.buildCredentialEgressClientEnv()).toEqual({
      ROOMOTE_SERVICE_BASE_URL: 'https://api.example.com/api/credential-egress',
      ROOMOTE_CREDENTIAL_EGRESS_SERVICES: '[]',
      ROOMOTE_SERVICE_TOKEN_EXAMPLE: `rses_${'a'.repeat(40)}`,
    });
    expect(env.buildCredentialEgressClientEnv()).not.toHaveProperty(
      'AUTH_TOKEN',
    );
  });

  it('waits for a real delivery and fails closed on authentication failure', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce({ environment: null })
      .mockResolvedValueOnce({ environment: { READY: 'yes' } });
    await expect(
      waitForCredentialEgressDelivery(read, new AbortController().signal),
    ).resolves.toEqual({ READY: 'yes' });
    expect(read).toHaveBeenCalledTimes(2);
    await expect(
      waitForCredentialEgressDelivery(
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
      waitForCredentialEgressDelivery(read, controller.signal),
    ).rejects.toThrow('run canceled');
    expect(read).not.toHaveBeenCalled();
  });
});
