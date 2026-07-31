const mocks = vi.hoisted(() => ({
  getDeploymentLicenseState: vi.fn(),
  getInstanceAnalyticsId: vi.fn(),
  resolveConfiguredLicenseKey: vi.fn(),
  resolveLicenseState: vi.fn(),
  findSettings: vi.fn(),
  updateSet: vi.fn(),
  updateWhere: vi.fn(),
}));

vi.mock('@roomote/env', () => ({
  Env: {
    RELEASE_VERSION: 'v1.2.3',
    R_LICENSE_CLOUD_BASE_URL: 'https://cloud.example.com/',
  },
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: { deploymentSettings: { findFirst: mocks.findSettings } },
    update: vi.fn(() => ({
      set: mocks.updateSet.mockReturnValue({ where: mocks.updateWhere }),
    })),
  },
  deploymentSettings: { id: 'id' },
  eq: vi.fn(),
  getDeploymentLicenseState: mocks.getDeploymentLicenseState,
  getInstanceAnalyticsId: mocks.getInstanceAnalyticsId,
  resolveConfiguredLicenseKey: mocks.resolveConfiguredLicenseKey,
  resolveLicenseState: mocks.resolveLicenseState,
}));

import { syncLicenseWithCloud } from '../server/license-cloud';

describe('syncLicenseWithCloud', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDeploymentLicenseState.mockResolvedValue({
      status: 'valid',
      seatLimit: 25,
      licenseId: 'lic_123',
    });
    mocks.findSettings.mockResolvedValue({ licenseKey: 'RMLK1.payload.sig' });
    mocks.resolveConfiguredLicenseKey.mockReturnValue('RMLK1.payload.sig');
    mocks.getInstanceAnalyticsId.mockResolvedValue('deployment-123');
    mocks.updateWhere.mockResolvedValue(undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          licenseId: 'lic_123',
          activationExpiresAt: '2026-08-03T00:00:00.000Z',
          entitlementsVersion: '2026-08-01',
          entitlements: { premiumFeature: true, maxProjects: 20 },
          entitlementsExpiresAt: '2026-08-03T00:00:00.000Z',
        }),
      }),
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  it('reports a stable deployment observation and caches the returned lease', async () => {
    await expect(
      syncLicenseWithCloud({
        eventId: 'event-123',
        observedAt: new Date('2026-08-01T12:00:00.000Z'),
        activeUsers: 17,
      }),
    ).resolves.toEqual({ status: 'synced' });

    expect(fetch).toHaveBeenCalledWith(
      'https://cloud.example.com/api/v1/licenses/report',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'License RMLK1.payload.sig',
        }),
      }),
    );
    const request = vi.mocked(fetch).mock.calls[0]?.[1];
    expect(JSON.parse(String(request?.body))).toEqual({
      contractVersion: 1,
      deploymentId: 'deployment-123',
      eventId: 'event-123',
      observedAt: '2026-08-01T12:00:00.000Z',
      appVersion: 'v1.2.3',
      usage: { activeUsers: 17 },
    });
    expect(mocks.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        licenseCloudState: expect.objectContaining({
          licenseId: 'lic_123',
          deploymentId: 'deployment-123',
          entitlements: { premiumFeature: true, maxProjects: 20 },
        }),
      }),
    );
  });

  it('does not issue a lease when Cloud reports another installation', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 409,
    } as Response);

    await expect(
      syncLicenseWithCloud({
        eventId: 'event-123',
        observedAt: new Date(),
        activeUsers: 17,
      }),
    ).resolves.toEqual({ status: 'license_in_use' });
    expect(mocks.updateSet).not.toHaveBeenCalled();
  });

  it('rejects a successful response with non-scalar entitlements', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        licenseId: 'lic_123',
        activationExpiresAt: '2026-08-03T00:00:00.000Z',
        entitlementsVersion: '2026-08-01',
        entitlements: { premiumFeature: true, nested: { enabled: true } },
        entitlementsExpiresAt: '2026-08-03T00:00:00.000Z',
      }),
    } as Response);

    await expect(
      syncLicenseWithCloud({
        eventId: 'event-123',
        observedAt: new Date(),
        activeUsers: 17,
      }),
    ).resolves.toEqual({ status: 'rejected' });
    expect(mocks.updateSet).not.toHaveBeenCalled();
  });
});
