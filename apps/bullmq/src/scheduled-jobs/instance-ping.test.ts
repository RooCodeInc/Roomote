const mocks = vi.hoisted(() => ({
  checkLatestVersion: vi.fn(),
  collectInstanceReportStats: vi.fn(),
  isAnonymousAnalyticsEnabled: vi.fn(),
  isTelemetryEnvAllowed: vi.fn(),
  recordLatestKnownVersion: vi.fn(),
  sendInstanceReport: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  collectInstanceReportStats: mocks.collectInstanceReportStats,
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
    mocks.isAnonymousAnalyticsEnabled.mockResolvedValue(true);
    mocks.collectInstanceReportStats.mockResolvedValue({ users: { total: 7 } });
    mocks.sendInstanceReport.mockResolvedValue(true);
  });

  it('sends the full instance report when anonymous analytics is enabled', async () => {
    const report = { users: { total: 7 }, tasks: { total: 12 } };
    mocks.collectInstanceReportStats.mockResolvedValue(report);

    await instancePingJob();

    expect(mocks.collectInstanceReportStats).toHaveBeenCalledOnce();
    expect(mocks.sendInstanceReport).toHaveBeenCalledWith(report);
  });

  it('skips the report after analytics opt-out', async () => {
    mocks.isAnonymousAnalyticsEnabled.mockResolvedValue(false);

    await instancePingJob();

    expect(mocks.collectInstanceReportStats).not.toHaveBeenCalled();
    expect(mocks.sendInstanceReport).not.toHaveBeenCalled();
  });
});
