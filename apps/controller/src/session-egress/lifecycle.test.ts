import { describe, expect, it, vi } from 'vitest';
import {
  buildSessionEgressServiceTokenEnv,
  TaskPayloadKind,
  type SessionEgressWorkloadRegistration,
} from '@roomote/types';

import {
  SessionEgressLifecycle,
  type SessionEgressLifecycleDependencies,
} from './lifecycle';

const workloadId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';
const registration: SessionEgressWorkloadRegistration = {
  workloadId,
  sessionId,
  generation: 1,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  substitutes: [
    {
      secretRef: '33333333-3333-4333-8333-333333333333',
      label: 'Example API',
      origin: 'https://api.example.com',
      headerName: 'authorization',
      headerPrefix: 'Bearer ',
      allowedMethods: ['GET', 'POST'],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      substitute: `rses_${'a'.repeat(40)}`,
    },
  ],
};

function dependencies(): SessionEgressLifecycleDependencies {
  return {
    apiProxyBaseUrl: 'https://api.roomote.test/api/session-egress',
    client: {
      register: vi.fn().mockResolvedValue(registration),
      issueSubstitutes: vi.fn(),
      renewLease: vi.fn(),
      terminate: vi.fn().mockResolvedValue({ workloadId, terminated: true }),
    },
    findCandidate: vi.fn().mockResolvedValue({
      sessionId,
      grantCount: 1,
      experimentEnabled: true,
    }),
    recordEvent: vi.fn(),
    logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

describe('controller-owned Session egress lifecycle', () => {
  it('renews only admitted workloads and stops on termination or API failure', async () => {
    vi.useFakeTimers();
    try {
      const deps = dependencies();
      const lifecycle = new SessionEgressLifecycle(deps);
      await vi.advanceTimersByTimeAsync(1_200_000);
      expect(deps.client!.renewLease).not.toHaveBeenCalled();
      lifecycle.startLeaseRenewal(1, workloadId);
      await vi.advanceTimersByTimeAsync(1_200_000);
      expect(deps.client!.renewLease).toHaveBeenCalledWith(workloadId, {
        leaseSeconds: 3600,
      });
      await lifecycle.terminate(1, workloadId, 'completed');
      await vi.advanceTimersByTimeAsync(1_200_000);
      expect(deps.client!.renewLease).toHaveBeenCalledTimes(1);
      vi.mocked(deps.client!.renewLease).mockRejectedValue(
        new Error('synthetic-private-failure'),
      );
      lifecycle.startLeaseRenewal(1, workloadId);
      await vi.advanceTimersByTimeAsync(2_400_000);
      expect(deps.client!.renewLease).toHaveBeenCalledTimes(2);
      expect(
        JSON.stringify(vi.mocked(deps.logger!.warn).mock.calls),
      ).not.toContain('synthetic-private-failure');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not mint a lease or substitute during normal bootstrap preflight', async () => {
    const deps = dependencies();
    expect(
      await new SessionEgressLifecycle(deps).needsBootstrapAdmission(
        1,
        'docker',
      ),
    ).toBe(true);
    expect(deps.client!.register).not.toHaveBeenCalled();
  });
  it.each(['docker', 'daytona', 'e2b', 'blaxel', 'box', 'azure'] as const)(
    'registers %s runs through the API proxy',
    async (provider) => {
      const deps = dependencies();
      const result = await new SessionEgressLifecycle(deps).register({
        taskRun: { id: 1, taskId: 'task1' },
        provider,
        resume: false,
      });
      expect(result).toMatchObject({
        status: 'registered',
        workload: registration,
      });
      expect(deps.client!.register).toHaveBeenCalledWith(
        expect.objectContaining({ runId: 1, provider }),
      );
    },
  );

  it('splits substitutes into scoped token env and a nonsecret manifest', () => {
    const { tokens, manifest } = buildSessionEgressServiceTokenEnv(
      registration.substitutes,
    );
    expect(tokens.ROOMOTE_SERVICE_TOKEN_EXAMPLE_API).toBe(
      registration.substitutes[0]!.substitute,
    );
    expect(JSON.stringify(manifest)).not.toContain(
      registration.substitutes[0]!.substitute,
    );
  });

  it('admits every provider through the API proxy without deployment configuration', async () => {
    vi.useFakeTimers();
    try {
      const deps = dependencies();
      const lifecycle = new SessionEgressLifecycle(deps);
      expect(lifecycle.admissionFor('modal')).toBe('api_proxy');
      expect(lifecycle.admissionFor('roomote')).toBe('api_proxy');
      expect(lifecycle.admissionFor('docker')).toBe('api_proxy');
      expect(await lifecycle.needsBootstrapAdmission(1, 'modal')).toBe(true);
      expect(deps.client!.register).not.toHaveBeenCalled();

      const result = await lifecycle.register({
        taskRun: { id: 1, taskId: 'task1' },
        provider: 'modal',
        resume: false,
      });
      expect(result).toMatchObject({
        status: 'registered',
        workload: registration,
      });
      if (result.status !== 'registered') throw new Error('unreachable');
      expect(result.connectorIdentity).toMatch(
        /^roomote:\/\/api-proxy\/run\/1\/[0-9a-f]{24}$/,
      );
      expect(deps.client!.register).toHaveBeenCalledWith({
        runId: 1,
        provider: 'modal',
        connectorIdentity: result.connectorIdentity,
        leaseSeconds: 3600,
      });
      const events = vi.mocked(deps.recordEvent).mock.calls;
      expect(events.at(-1)![0]).toMatchObject({
        eventType: 'decision',
        details: { status: 'registered', admission: 'api_proxy' },
      });
      expect(JSON.stringify(events)).not.toContain(
        registration.substitutes[0]!.substitute,
      );

      lifecycle.startLeaseRenewal(1, workloadId);
      await vi.advanceTimersByTimeAsync(1_200_000);
      expect(deps.client!.renewLease).toHaveBeenCalledWith(workloadId, {
        leaseSeconds: 3600,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['modal', 'docker'] as const)(
    'skips %s runs whose Session owner has not enabled Session secret tools',
    async (provider) => {
      const deps = dependencies();
      vi.mocked(deps.findCandidate).mockResolvedValue({
        sessionId,
        grantCount: 2,
        experimentEnabled: false,
      });
      const lifecycle = new SessionEgressLifecycle(deps);
      expect(await lifecycle.needsBootstrapAdmission(1, provider)).toBe(false);
      await expect(
        lifecycle.register({
          taskRun: { id: 1, taskId: 'task1' },
          provider,
          resume: false,
        }),
      ).resolves.toEqual({ status: 'skipped', reason: 'disabled' });
      expect(deps.client!.register).not.toHaveBeenCalled();
      const events = vi.mocked(deps.recordEvent).mock.calls;
      expect(events.at(-1)![0].message).toContain(
        'has not enabled Session secret tools',
      );
    },
  );

  it.each([
    'modal',
    'roomote',
    'docker',
    'daytona',
    'e2b',
    'blaxel',
    'box',
    'azure',
  ] as const)(
    'plans API-proxy admission for %s launches and rotates on resume',
    async (provider) => {
      const admitApiProxy = vi.fn().mockResolvedValue(registration);
      const deps = { ...dependencies(), admitApiProxy };
      const lifecycle = new SessionEgressLifecycle(deps);

      const plan = await lifecycle.planApiProxy({
        taskRun: {
          id: 1,
          taskId: 'task1',
          payloadKind: TaskPayloadKind.StandardTask,
        },
        provider,
      });
      expect(plan.required).toBe(true);
      expect(plan.bootstrapEnv).toEqual({
        ROOMOTE_SESSION_EGRESS_BOOTSTRAP_REQUIRED: '1',
        ROOMOTE_SESSION_EGRESS_BOOTSTRAP_NONCE:
          expect.stringMatching(/^[0-9a-f-]{36}$/),
      });
      // Planning mints nothing; only admission registers the run.
      expect(admitApiProxy).not.toHaveBeenCalled();
      expect(deps.client!.register).not.toHaveBeenCalled();

      await expect(plan.admit()).resolves.toBe(registration);
      expect(admitApiProxy).toHaveBeenCalledWith({
        lifecycle,
        taskRun: { id: 1, taskId: 'task1' },
        provider,
        nonce: plan.bootstrapEnv.ROOMOTE_SESSION_EGRESS_BOOTSTRAP_NONCE,
        baseUrl: 'https://api.roomote.test/api/session-egress',
        resume: false,
      });
      expect(
        JSON.stringify(vi.mocked(deps.logger!.log).mock.calls),
      ).not.toContain(registration.substitutes[0]!.substitute);

      const resumed = await lifecycle.planApiProxy({
        taskRun: {
          id: 1,
          taskId: 'task1',
          payloadKind: TaskPayloadKind.SnapshotResume,
        },
        provider,
      });
      await resumed.admit();
      expect(admitApiProxy).toHaveBeenLastCalledWith(
        expect.objectContaining({ resume: true }),
      );
    },
  );

  it('lets a launcher name the proxy address its sandbox can reach', async () => {
    const admitApiProxy = vi.fn().mockResolvedValue(registration);
    const lifecycle = new SessionEgressLifecycle({
      ...dependencies(),
      admitApiProxy,
    });
    const plan = await lifecycle.planApiProxy({
      taskRun: {
        id: 1,
        taskId: 'task1',
        payloadKind: TaskPayloadKind.StandardTask,
      },
      provider: 'docker',
      baseUrl: 'http://api:3001/api/session-egress',
    });
    await plan.admit();
    expect(admitApiProxy).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'docker',
        baseUrl: 'http://api:3001/api/session-egress',
      }),
    );
  });

  it('plans no API-proxy admission for runs without grants', async () => {
    const admitApiProxy = vi.fn();
    const deps = { ...dependencies(), admitApiProxy };
    const lifecycle = new SessionEgressLifecycle(deps);
    const taskRun = {
      id: 1,
      taskId: 'task1',
      payloadKind: TaskPayloadKind.StandardTask,
    };

    vi.mocked(deps.findCandidate).mockResolvedValue({
      sessionId,
      grantCount: 0,
      experimentEnabled: true,
    });
    const idle = await lifecycle.planApiProxy({ taskRun, provider: 'daytona' });
    expect(idle.required).toBe(false);
    await expect(idle.admit()).resolves.toBeNull();

    expect(admitApiProxy).not.toHaveBeenCalled();
    expect(deps.client!.register).not.toHaveBeenCalled();
  });

  it('keeps API-proxy admission closed without a proxy base URL', async () => {
    const deps = { ...dependencies(), admitApiProxy: vi.fn() };
    delete deps.apiProxyBaseUrl;
    const lifecycle = new SessionEgressLifecycle(deps);
    expect(lifecycle.admissionFor('modal')).toBeNull();

    const plan = await lifecycle.planApiProxy({
      taskRun: {
        id: 1,
        taskId: 'task1',
        payloadKind: TaskPayloadKind.StandardTask,
      },
      provider: 'e2b',
    });
    expect(plan.required).toBe(false);
    expect(deps.admitApiProxy).not.toHaveBeenCalled();
    expect(deps.client!.register).not.toHaveBeenCalled();
    const events = vi.mocked(deps.recordEvent).mock.calls;
    expect(events.at(-1)![0].message).toContain('unavailable');
  });
});
