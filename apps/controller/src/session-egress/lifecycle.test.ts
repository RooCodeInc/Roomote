import { X509Certificate } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';
import {
  buildSessionEgressClientEnv,
  buildSessionEgressServiceTokenEnv,
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
    client: {
      register: vi.fn().mockResolvedValue(registration),
      issueSubstitutes: vi.fn(),
      renewLease: vi.fn(),
      terminate: vi.fn().mockResolvedValue({ workloadId, terminated: true }),
    },
    findCandidate: vi.fn().mockResolvedValue({ sessionId, grantCount: 1 }),
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

  it.each([
    'modal',
    'daytona',
    'e2b',
    'blaxel',
    'box',
    'azure',
    'roomote',
  ] as const)(
    'does not mint substitutes for an unenforced %s adapter',
    async (provider) => {
      const deps = dependencies();
      await expect(
        new SessionEgressLifecycle(deps).register({
          taskRun: { id: 1, taskId: 'task1' },
          provider,
          resume: false,
        }),
      ).resolves.toEqual({ status: 'skipped', reason: 'unsupported_provider' });
      expect(deps.client!.register).not.toHaveBeenCalled();
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
});
