const mocks = vi.hoisted(() => ({
  findSettings: vi.fn(),
  getDeploymentLicenseState: vi.fn(),
  getInstanceAnalyticsId: vi.fn(),
  isAnonymousAnalyticsEnabledFromMetadata: vi.fn(),
}));

vi.mock('@roomote/env', () => ({
  Env: {
    APP_ENV: 'production',
    RELEASE_VERSION: 'v1.2.3',
    ROOMOTE_FORCE_TELEMETRY: undefined,
    R_PING_BASE_URL: 'https://ping.roomote.dev',
    R_CLOUD_ENABLED: 'false',
  },
  isRoomoteCloudEnabled: () => false,
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      deploymentSettings: { findFirst: mocks.findSettings },
    },
  },
  deploymentSettings: { id: 'id' },
  eq: vi.fn(),
  getDeploymentLicenseState: mocks.getDeploymentLicenseState,
  getInstanceAnalyticsId: mocks.getInstanceAnalyticsId,
  getUserAnalyticsId: vi.fn(),
  taskRuns: {},
}));

vi.mock('@roomote/feature-flags', () => ({
  isAnonymousAnalyticsEnabledFromMetadata:
    mocks.isAnonymousAnalyticsEnabledFromMetadata,
}));

import { sendInstanceReport } from '../server';

describe('sendInstanceReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findSettings.mockResolvedValue({ metadata: {} });
    mocks.getInstanceAnalyticsId.mockResolvedValue('instance-123');
    mocks.isAnonymousAnalyticsEnabledFromMetadata.mockReturnValue(false);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200 }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('includes a valid license id when analytics is disabled', async () => {
    mocks.getDeploymentLicenseState.mockResolvedValue({
      status: 'valid',
      seatLimit: 100,
      licenseId: 'lic_sh_123',
      licensee: 'Engineering',
      maxSeats: 100,
      issuedAt: new Date('2026-01-01T00:00:00Z'),
      expiresAt: new Date('2027-01-01T00:00:00Z'),
    });

    await expect(sendInstanceReport({ users: { total: 17 } })).resolves.toBe(
      true,
    );

    expect(fetch).toHaveBeenCalledWith(
      'https://ping.roomote.dev/v1/instance-report',
      expect.objectContaining({
        body: expect.any(String),
      }),
    );
    const request = vi.mocked(fetch).mock.calls[0]?.[1];
    expect(JSON.parse(String(request?.body))).toMatchObject({
      instanceId: 'instance-123',
      appVersion: 'v1.2.3',
      licenseId: 'lic_sh_123',
      cloud: false,
      report: { users: { total: 17 } },
    });
  });

  it('does not report an expired license after analytics opt-out', async () => {
    mocks.getDeploymentLicenseState.mockResolvedValue({
      status: 'expired',
      seatLimit: 10,
      licenseId: 'lic_sh_123',
      licensee: 'Engineering',
      maxSeats: 100,
      issuedAt: new Date('2025-01-01T00:00:00Z'),
      expiresAt: new Date('2026-01-01T00:00:00Z'),
    });

    await expect(sendInstanceReport({ users: { total: 17 } })).resolves.toBe(
      false,
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});
