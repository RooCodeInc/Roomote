const mocks = vi.hoisted(() => ({
  checkLatestVersion: vi.fn(),
  collectInstanceReportStats: vi.fn(),
  collectLicensedUserCount: vi.fn(),
  getDeploymentLicenseState: vi.fn(),
  isAnonymousAnalyticsEnabled: vi.fn(),
  isTelemetryEnvAllowed: vi.fn(),
  recordLatestKnownVersion: vi.fn(),
  sendInstanceReport: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  collectInstanceReportStats: mocks.collectInstanceReportStats,
  collectLicensedUserCount: mocks.collectLicensedUserCount,
  getDeploymentLicenseState: mocks.getDeploymentLicenseState,
  recordLatestKnownVersion: mocks.recordLatestKnownVersion,
}));

vi.mock('@roomote/telemetry/server', () => ({
  checkLatestVersion: mocks.checkLatestVersion,
  isAnonymousAnalyticsEnabled: mocks.isAnonymousAnalyticsEnabled,
  isTelemetryEnvAllowed: mocks.isTelemetryEnvAllowed,
  sendInstanceReport: mocks.sendInstanceReport,
}));

import { instancePingJob } from './instance-ping';

describe('instancePingJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isTelemetryEnvAllowed.mockReturnValue(true);
    mocks.checkLatestVersion.mockResolvedValue(null);
    mocks.getDeploymentLicenseState.mockResolvedValue({
      status: 'unlicensed',
      seatLimit: 10,
    });
    mocks.isAnonymousAnalyticsEnabled.mockResolvedValue(true);
    mocks.collectInstanceReportStats.mockResolvedValue({ users: { total: 7 } });
    mocks.collectLicensedUserCount.mockResolvedValue({ users: { total: 7 } });
    mocks.sendInstanceReport.mockResolvedValue(true);
  });

  it('sends the full instance report when anonymous analytics is enabled', async () => {
    const report = { users: { total: 7 }, tasks: { total: 12 } };
    mocks.collectInstanceReportStats.mockResolvedValue(report);

    await instancePingJob();

    expect(mocks.collectInstanceReportStats).toHaveBeenCalledOnce();
    expect(mocks.collectLicensedUserCount).not.toHaveBeenCalled();
    expect(mocks.sendInstanceReport).toHaveBeenCalledWith(report);
  });

  it('sends only user count for a valid license after analytics opt-out', async () => {
    mocks.isAnonymousAnalyticsEnabled.mockResolvedValue(false);
    mocks.getDeploymentLicenseState.mockResolvedValue({
      status: 'valid',
      seatLimit: 100,
      licenseId: 'lic_sh_123',
      licensee: 'Engineering',
      maxSeats: 100,
      issuedAt: new Date('2026-01-01T00:00:00Z'),
      expiresAt: new Date('2027-01-01T00:00:00Z'),
    });

    await instancePingJob();

    expect(mocks.collectInstanceReportStats).not.toHaveBeenCalled();
    expect(mocks.collectLicensedUserCount).toHaveBeenCalledOnce();
    expect(mocks.sendInstanceReport).toHaveBeenCalledWith({
      users: { total: 7 },
    });
  });

  it('skips the report after opt-out when there is no valid license', async () => {
    mocks.isAnonymousAnalyticsEnabled.mockResolvedValue(false);

    await instancePingJob();

    expect(mocks.collectInstanceReportStats).not.toHaveBeenCalled();
    expect(mocks.collectLicensedUserCount).not.toHaveBeenCalled();
    expect(mocks.sendInstanceReport).not.toHaveBeenCalled();
  });
});
