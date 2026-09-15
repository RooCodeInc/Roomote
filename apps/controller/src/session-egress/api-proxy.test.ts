import { describe, expect, it, vi } from 'vitest';
import type { SessionEgressWorkloadRegistration } from '@roomote/types';

import {
  admitSessionEgressApiProxy,
  buildSessionEgressApiProxyWorkerEnv,
  resolveSessionEgressApiProxyBaseUrl,
  type ApiProxyAdmissionDependencies,
} from './api-proxy';
import type { SessionEgressLifecycle } from './lifecycle';

const workloadId = '11111111-1111-4111-8111-111111111111';
const substitute = `rses_${'b'.repeat(43)}`;
const registration: SessionEgressWorkloadRegistration = {
  workloadId,
  sessionId: '22222222-2222-4222-8222-222222222222',
  generation: 2,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  substitutes: [
    {
      secretRef: '33333333-3333-4333-8333-333333333333',
      label: 'Stripe',
      origin: 'https://api.stripe.com',
      headerName: 'authorization',
      headerPrefix: 'Bearer ',
      allowedMethods: ['GET', 'HEAD'],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      substitute,
    },
  ],
};
const baseUrl = 'https://api.roomote.test/api/session-egress';

function lifecycle(
  outcome: Awaited<ReturnType<SessionEgressLifecycle['register']>> = {
    status: 'registered',
    workload: registration,
    connectorIdentity: 'roomote://api-proxy/run/7/abc',
  },
) {
  return {
    register: vi.fn().mockResolvedValue(outcome),
    terminate: vi.fn().mockResolvedValue(true),
    startLeaseRenewal: vi.fn(),
  } as unknown as SessionEgressLifecycle & {
    register: ReturnType<typeof vi.fn>;
    terminate: ReturnType<typeof vi.fn>;
    startLeaseRenewal: ReturnType<typeof vi.fn>;
  };
}

function deps(
  overrides: Partial<ApiProxyAdmissionDependencies> = {},
): ApiProxyAdmissionDependencies & { clock: { now: number } } {
  const clock = { now: 1_000_000 };
  return {
    clock,
    isBootstrapReady: vi.fn().mockResolvedValue(true),
    isRunActive: vi.fn().mockResolvedValue(true),
    publish: vi.fn().mockResolvedValue(undefined),
    sleep: vi.fn(async () => {
      clock.now += 500;
    }),
    now: () => clock.now,
    ...overrides,
  };
}

const input = (cycle: SessionEgressLifecycle) => ({
  lifecycle: cycle,
  taskRun: { id: 7, taskId: 'task7' },
  provider: 'modal' as const,
  nonce: '44444444-4444-4444-8444-444444444444',
  baseUrl,
});

describe('API-proxy admission', () => {
  it('builds substitute-only client configuration with one base URL and no proxy settings', () => {
    const env = buildSessionEgressApiProxyWorkerEnv({ registration, baseUrl });
    expect(env).toEqual({
      ROOMOTE_SERVICE_BASE_URL: baseUrl,
      ROOMOTE_SESSION_EGRESS_SERVICES: JSON.stringify([
        {
          secretRef: registration.substitutes[0]!.secretRef,
          label: 'Stripe',
          origin: 'https://api.stripe.com',
          headerName: 'authorization',
          headerPrefix: 'Bearer ',
          allowedMethods: ['GET', 'HEAD'],
          expiresAt: registration.substitutes[0]!.expiresAt,
          envName: 'ROOMOTE_SERVICE_TOKEN_STRIPE',
          baseUrl,
        },
      ]),
      ROOMOTE_SERVICE_TOKEN_STRIPE: substitute,
    });
    expect(Object.keys(env).some((key) => /proxy/i.test(key))).toBe(false);
  });

  it('derives the base URL from the API origin or the dedicated proxy host', () => {
    expect(
      resolveSessionEgressApiProxyBaseUrl({
        TRPC_URL: 'https://api.roomote.test/',
      }),
    ).toBe(baseUrl);
    expect(
      resolveSessionEgressApiProxyBaseUrl({
        TRPC_URL: 'https://api.roomote.test',
        R_SESSION_EGRESS_PROXY_HOST: 'egress.roomote.test',
      }),
    ).toBe('https://egress.roomote.test');
  });

  it('waits for bootstrap, registers, publishes bound to the nonce, then renews', async () => {
    const cycle = lifecycle();
    const d = deps({
      isBootstrapReady: vi
        .fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)
        .mockResolvedValue(true),
    });
    const order: string[] = [];
    vi.mocked(cycle.register).mockImplementation(async () => {
      order.push('register');
      return {
        status: 'registered',
        workload: registration,
        connectorIdentity: 'roomote://api-proxy/run/7/abc',
      };
    });
    vi.mocked(d.publish).mockImplementation(async () => {
      order.push('publish');
    });
    vi.mocked(cycle.startLeaseRenewal).mockImplementation(() => {
      order.push('renew');
    });

    await expect(admitSessionEgressApiProxy(input(cycle), d)).resolves.toBe(
      registration,
    );
    expect(d.sleep).toHaveBeenCalledTimes(2);
    expect(order).toEqual(['register', 'publish', 'renew']);
    expect(cycle.register).toHaveBeenCalledWith({
      taskRun: { id: 7, taskId: 'task7' },
      provider: 'modal',
      resume: false,
    });
    expect(d.publish).toHaveBeenCalledWith(
      7,
      registration,
      expect.objectContaining({
        ROOMOTE_SERVICE_BASE_URL: baseUrl,
        ROOMOTE_SERVICE_TOKEN_STRIPE: substitute,
      }),
      '44444444-4444-4444-8444-444444444444',
    );
    expect(cycle.startLeaseRenewal).toHaveBeenCalledWith(7, workloadId);
    expect(cycle.terminate).not.toHaveBeenCalled();
  });

  it('never registers when the run stops or bootstrap never completes', async () => {
    const stopped = lifecycle();
    await expect(
      admitSessionEgressApiProxy(
        input(stopped),
        deps({ isRunActive: vi.fn().mockResolvedValue(false) }),
      ),
    ).rejects.toThrow('no longer active');
    expect(stopped.register).not.toHaveBeenCalled();

    const silent = lifecycle();
    const d = deps({ isBootstrapReady: vi.fn().mockResolvedValue(false) });
    vi.mocked(d.sleep).mockImplementation(async () => {
      d.clock.now += 5 * 60_000;
    });
    await expect(admitSessionEgressApiProxy(input(silent), d)).rejects.toThrow(
      'timed out',
    );
    expect(silent.register).not.toHaveBeenCalled();
  });

  it('retires the workload when delivery fails and refuses ineligible runs', async () => {
    const failing = lifecycle();
    await expect(
      admitSessionEgressApiProxy(
        input(failing),
        deps({
          publish: vi.fn().mockRejectedValue(new Error('redis-private-detail')),
        }),
      ),
    ).rejects.toThrow('redis-private-detail');
    expect(failing.terminate).toHaveBeenCalledWith(
      7,
      workloadId,
      'provision_failed',
    );
    expect(failing.startLeaseRenewal).not.toHaveBeenCalled();

    const skipped = lifecycle({ status: 'skipped', reason: 'no_grants' });
    await expect(
      admitSessionEgressApiProxy(input(skipped), deps()),
    ).rejects.toThrow('no longer eligible');
  });
});
