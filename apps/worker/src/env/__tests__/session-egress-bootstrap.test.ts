import { describe, expect, it, vi } from 'vitest';
import { WorkerEnv } from '../worker-env';
import { waitForSessionEgressDelivery } from '../session-egress-bootstrap';

const service = {
  secretRef: '11111111-1111-4111-8111-111111111111',
  label: 'Example',
  origin: 'https://api.example.com',
  headerName: 'authorization',
  headerPrefix: 'Bearer ',
  allowedMethods: ['GET', 'POST'],
  expiresAt: '2099-01-01T00:00:00.000Z',
  envName: 'ROOMOTE_SERVICE_TOKEN_EXAMPLE',
};

describe('protected execution bootstrap', () => {
  it('builds scoped shared-proxy settings without changing global bootstrap/inference routing', () => {
    const env = WorkerEnv.fromProcessEnv({
      AUTH_TOKEN: 'run-auth',
      TRPC_URL: 'https://api.example.com',
      R_APP_URL: 'https://roomote.example',
    });
    const token = `rproxy_${'a'.repeat(43)}`;
    env.acceptSessionEgressDelivery({
      ROOMOTE_SESSION_EGRESS_ADMISSION_MODE: 'authenticated_proxy',
      ROOMOTE_SESSION_EGRESS_PROXY_URL: 'https://proxy.example.com:8444',
      ROOMOTE_SESSION_EGRESS_CA_FILE: '/public-ca.pem',
      ROOMOTE_SESSION_PROXY_CAPABILITY: token,
      ROOMOTE_SESSION_PROXY_CAPABILITY_EXPIRES_AT: '2099-01-01T00:00:00.000Z',
      ROOMOTE_SESSION_EGRESS_SERVICES: JSON.stringify([service]),
      ROOMOTE_SERVICE_TOKEN_EXAMPLE: 'rses_fixture',
    });
    const settings = env.buildSessionEgressClientEnv();
    expect(env.sessionEgressAdmissionMode).toBe('authenticated_proxy');
    const proxy = new URL(settings.ROOMOTE_SESSION_PROXY_URL!);
    expect(proxy.username).toBe('workload');
    expect(proxy.password).toBe(token);
    expect(settings).not.toHaveProperty('HTTPS_PROXY');
    expect(settings).not.toHaveProperty('NO_PROXY');
    expect(settings).not.toHaveProperty('SSL_CERT_FILE');
    expect(settings).not.toHaveProperty('ROOMOTE_SESSION_EGRESS_ENFORCED');
    expect(settings).not.toHaveProperty('AUTH_TOKEN');
  });

  it('rejects expired shared-proxy capability delivery', () => {
    const env = WorkerEnv.fromProcessEnv({
      AUTH_TOKEN: 'run-auth',
      TRPC_URL: 'https://api.example.com',
      R_APP_URL: 'https://roomote.example',
    });
    expect(() =>
      env.acceptSessionEgressDelivery({
        ROOMOTE_SESSION_EGRESS_ADMISSION_MODE: 'authenticated_proxy',
        ROOMOTE_SESSION_EGRESS_PROXY_URL: 'https://proxy.example.com',
        ROOMOTE_SESSION_EGRESS_CA_FILE: '/public-ca.pem',
        ROOMOTE_SESSION_PROXY_CAPABILITY: `rproxy_${'a'.repeat(43)}`,
        ROOMOTE_SESSION_PROXY_CAPABILITY_EXPIRES_AT: '2000-01-01T00:00:00.000Z',
        ROOMOTE_SESSION_EGRESS_SERVICES: '[]',
      }),
    ).toThrow('expired');
  });
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
      ROOMOTE_SESSION_EGRESS_SERVICES: JSON.stringify([service]),
    });
    expect(env.buildSessionEgressClientEnv()).toMatchObject({
      HTTPS_PROXY: 'http://connector:3128',
      NODE_USE_ENV_PROXY: '1',
      ROOMOTE_SERVICE_TOKEN_EXAMPLE: `rses_${'a'.repeat(40)}`,
    });
    expect(env.buildSessionEgressClientEnv()).not.toHaveProperty('AUTH_TOKEN');
  });

  it.each([
    'missing manifest',
    'generic SECRET mapping',
    'missing substitute',
    'real key',
    'duplicate mapping',
  ])(
    'rejects %s without falling back to other environment credentials',
    (mode) => {
      const env = WorkerEnv.fromProcessEnv({
        AUTH_TOKEN: 'run-auth',
        TRPC_URL: 'http://api:3001',
        R_APP_URL: 'https://roomote.example',
      });
      const delivery: Record<string, string> = {
        ROOMOTE_SESSION_EGRESS_PROXY_URL: 'http://connector:3128',
        ROOMOTE_SESSION_EGRESS_CA_FILE: '/public-ca.pem',
        ROOMOTE_SESSION_EGRESS_SERVICES: JSON.stringify([service]),
        ROOMOTE_SERVICE_TOKEN_EXAMPLE: `rses_${'a'.repeat(40)}`,
        SECRET: 'unrelated-value',
      };
      if (mode === 'missing manifest')
        delete delivery.ROOMOTE_SESSION_EGRESS_SERVICES;
      if (mode === 'generic SECRET mapping')
        delivery.ROOMOTE_SESSION_EGRESS_SERVICES = JSON.stringify([
          { ...service, envName: 'SECRET' },
        ]);
      if (mode === 'missing substitute')
        delete delivery.ROOMOTE_SERVICE_TOKEN_EXAMPLE;
      if (mode === 'real key')
        delivery.ROOMOTE_SERVICE_TOKEN_EXAMPLE = 'real-key';
      if (mode === 'duplicate mapping')
        delivery.ROOMOTE_SESSION_EGRESS_SERVICES = JSON.stringify([
          service,
          service,
        ]);
      expect(() => env.acceptSessionEgressDelivery(delivery)).toThrow(
        'no credential fallback',
      );
      expect(env.buildSessionEgressClientEnv()).toEqual({});
      expect(delivery.SECRET).toBe('unrelated-value');
    },
  );

  it('delivers only explicitly mapped substitutes, not stray service-token variables', () => {
    const env = WorkerEnv.fromProcessEnv({
      AUTH_TOKEN: 'run-auth',
      TRPC_URL: 'http://api:3001',
      R_APP_URL: 'https://roomote.example',
    });
    env.acceptSessionEgressDelivery({
      ROOMOTE_SESSION_EGRESS_PROXY_URL: 'http://connector:3128',
      ROOMOTE_SESSION_EGRESS_CA_FILE: '/public-ca.pem',
      ROOMOTE_SESSION_EGRESS_SERVICES: JSON.stringify([service]),
      ROOMOTE_SERVICE_TOKEN_EXAMPLE: 'rses_fixture',
      ROOMOTE_SERVICE_TOKEN_OTHER: 'rses_other',
    });
    expect(env.buildSessionEgressClientEnv()).toHaveProperty(
      service.envName,
      'rses_fixture',
    );
    expect(env.buildSessionEgressClientEnv()).not.toHaveProperty(
      'ROOMOTE_SERVICE_TOKEN_OTHER',
    );
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
