import { X509Certificate } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';
import {
  buildSessionEgressClientEnv,
  buildSessionEgressServiceTokenEnv,
  TaskPayloadKind,
  type SessionEgressWorkloadRegistration,
} from '@roomote/types';

import {
  createSelfSignedConnectorCa,
  issueConnectorCertificate,
} from './connector-certificate';
import {
  SessionEgressLifecycle,
  admitBootstrappedSessionEgress,
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
    config: {
      gatewayAddr: 'gateway:8443',
      gatewayNetwork: 'gateway-network',
      gatewayCaCertificatePem: 'public-ca',
      connectorCa: createSelfSignedConnectorCa(),
      connectorImage: 'pinned-iron',
      leaseSeconds: 3600,
    },
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
  it('never delivers substitutes while untrusted bootstrap or enforcement is incomplete', async () => {
    const order: string[] = [];
    let finishSetup!: () => void;
    const setup = new Promise<void>((resolve) => {
      finishSetup = resolve;
    });
    const deliver = vi.fn(async () => {
      order.push('deliver');
    });
    const admission = admitBootstrappedSessionEgress({
      waitForBootstrap: async () => {
        order.push('bootstrap');
        await setup;
      },
      enforceAndVerify: async () => {
        expect(deliver).not.toHaveBeenCalled();
        order.push('verified-host-policy');
      },
      deliver,
    });
    expect(deliver).not.toHaveBeenCalled();
    finishSetup();
    await admission;
    expect(order).toEqual(['bootstrap', 'verified-host-policy', 'deliver']);
  });

  it('does not release configuration on a partial admission transition', async () => {
    const deliver = vi.fn();
    await expect(
      admitBootstrappedSessionEgress({
        waitForBootstrap: async () => {},
        enforceAndVerify: async () => {
          throw new Error('host policy verification failed');
        },
        deliver,
      }),
    ).rejects.toThrow('host policy verification failed');
    expect(deliver).not.toHaveBeenCalled();
  });

  it('prepares a workload-bound client certificate without claiming provisioning succeeded', async () => {
    const deps = dependencies();
    const result = await new SessionEgressLifecycle(deps).register({
      taskRun: { id: 1, taskId: 'task1' },
      provider: 'docker',
      resume: false,
    });
    expect(result.status).toBe('registered');
    if (result.status !== 'registered') throw new Error('registration failed');
    if (result.admission !== 'connector')
      throw new Error('expected connector admission');
    const certificate = new X509Certificate(result.connector.certificatePem);
    expect(certificate.subjectAltName).toContain(
      `URI:roomote://workload/${workloadId}`,
    );
    expect(certificate.subjectAltName).toContain(
      `URI:${result.connectorIdentity}`,
    );
    expect(certificate.ca).toBe(false);
    const events = vi.mocked(deps.recordEvent).mock.calls;
    expect(events.at(-1)![0].message).toContain(
      'provisioning is still required',
    );
    expect(JSON.stringify(events)).not.toContain(
      result.connector.privateKeyPem,
    );
    expect(JSON.stringify(events)).not.toContain(
      registration.substitutes[0]!.substitute,
    );
  });

  it.each(['daytona', 'e2b', 'blaxel', 'box', 'azure'] as const)(
    'registers %s runs through the API proxy rather than a connector',
    async (provider) => {
      const deps = dependencies();
      const result = await new SessionEgressLifecycle(deps).register({
        taskRun: { id: 1, taskId: 'task1' },
        provider,
        resume: false,
      });
      expect(result).toMatchObject({
        status: 'registered',
        admission: 'api_proxy',
        workload: registration,
      });
      expect('connector' in result).toBe(false);
      expect(deps.client!.register).toHaveBeenCalledWith(
        expect.objectContaining({ runId: 1, provider }),
      );
      expect(deps.issueCertificate).toBeUndefined();
    },
  );

  it('retires the generation when certificate provisioning fails without exposing error contents', async () => {
    const deps = dependencies();
    deps.issueCertificate = () => {
      throw new Error('synthetic-private-material');
    };
    const result = await new SessionEgressLifecycle(deps).register({
      taskRun: { id: 1, taskId: 'task1' },
      provider: 'docker',
      resume: true,
    });
    expect(result.status).toBe('failed');
    expect(deps.client!.terminate).toHaveBeenCalledWith(workloadId, {
      reason: 'provision_failed',
    });
    expect(JSON.stringify(result)).not.toContain('synthetic-private-material');
    expect(
      JSON.stringify(vi.mocked(deps.recordEvent).mock.calls),
    ).not.toContain('synthetic-private-material');
  });

  it('bounds connector certificates to the issuing CA lifetime', () => {
    const ca = createSelfSignedConnectorCa('test-ca', 300);
    const certificate = issueConnectorCertificate(ca, {
      connectorIdentity: 'spiffe://roomote/connector/test',
      workloadId,
      validitySeconds: 3600,
    });
    expect(certificate.notAfter.getTime()).toBeLessThanOrEqual(
      Date.parse(new X509Certificate(ca.certificatePem).validTo),
    );
    expect(() =>
      issueConnectorCertificate(ca, {
        connectorIdentity: 'spiffe://roomote/connector/test',
        workloadId,
        validitySeconds: 3600,
        now: new Date(Date.now() + 600_000),
      }),
    ).toThrow('not currently valid');
  });

  it('constructs standard-client configuration and only scoped substitutes', () => {
    const env = buildSessionEgressClientEnv({
      proxyUrl: 'http://connector:3128',
      caFile: '/etc/roomote/public-ca.pem',
      noProxy: 'api',
    });
    expect(env).toMatchObject({
      HTTPS_PROXY: 'http://connector:3128',
      NODE_USE_ENV_PROXY: '1',
      NODE_EXTRA_CA_CERTS: '/etc/roomote/public-ca.pem',
      REQUESTS_CA_BUNDLE: '/etc/roomote/public-ca.pem',
    });
    expect(env).not.toHaveProperty('NODE_TLS_REJECT_UNAUTHORIZED');
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

  it('admits connector-less providers through the API proxy without gateway configuration', async () => {
    vi.useFakeTimers();
    try {
      const deps = { ...dependencies(), config: null };
      const lifecycle = new SessionEgressLifecycle(deps);
      expect(await lifecycle.admissionFor('modal')).toBe('api_proxy');
      expect(await lifecycle.admissionFor('roomote')).toBe('api_proxy');
      // Without gateway configuration the connector path stays closed.
      expect(await lifecycle.admissionFor('docker')).toBeNull();
      expect(await lifecycle.needsBootstrapAdmission(1, 'modal')).toBe(true);
      expect(deps.client!.register).not.toHaveBeenCalled();

      const result = await lifecycle.register({
        taskRun: { id: 1, taskId: 'task1' },
        provider: 'modal',
        resume: false,
      });
      expect(result).toMatchObject({
        status: 'registered',
        admission: 'api_proxy',
        workload: registration,
      });
      if (result.status !== 'registered') throw new Error('unreachable');
      expect(result.connectorIdentity).toMatch(
        /^roomote:\/\/api-proxy\/run\/1\/[0-9a-f]{24}$/,
      );
      expect('connector' in result).toBe(false);
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

      // Lease renewal needs no gateway configuration either.
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
    'daytona',
    'e2b',
    'blaxel',
    'box',
    'azure',
  ] as const)(
    'plans API-proxy admission for %s launches and rotates on resume',
    async (provider) => {
      const admitApiProxy = vi.fn().mockResolvedValue(registration);
      const deps = { ...dependencies(), config: null, admitApiProxy };
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

  it('plans no API-proxy admission for connector providers or runs without grants', async () => {
    const admitApiProxy = vi.fn();
    const deps = { ...dependencies(), admitApiProxy };
    const lifecycle = new SessionEgressLifecycle(deps);
    const taskRun = {
      id: 1,
      taskId: 'task1',
      payloadKind: TaskPayloadKind.StandardTask,
    };

    // Docker admits through its connector, never through the proxy.
    const docker = await lifecycle.planApiProxy({
      taskRun,
      provider: 'docker',
    });
    expect(docker).toMatchObject({ required: false, bootstrapEnv: {} });
    await expect(docker.admit()).resolves.toBeNull();

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
    const deps = { ...dependencies(), config: null, admitApiProxy: vi.fn() };
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
