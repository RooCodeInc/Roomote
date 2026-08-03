const mocks = vi.hoisted(() => ({
  listPendingLicenseUsageObservations: vi.fn(),
  markLicenseUsageObservationAttempt: vi.fn(),
  markLicenseUsageObservationDelivered: vi.fn(),
  recordDailyLicenseUsageObservation: vi.fn(),
  syncLicenseWithCloud: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  listPendingLicenseUsageObservations:
    mocks.listPendingLicenseUsageObservations,
  markLicenseUsageObservationAttempt: mocks.markLicenseUsageObservationAttempt,
  markLicenseUsageObservationDelivered:
    mocks.markLicenseUsageObservationDelivered,
  recordDailyLicenseUsageObservation: mocks.recordDailyLicenseUsageObservation,
}));

vi.mock('@roomote/telemetry/server', () => ({
  syncLicenseWithCloud: mocks.syncLicenseWithCloud,
}));

import { licenseUsageSyncJob } from './license-usage-sync';

describe('licenseUsageSyncJob', () => {
  const observation = {
    id: 'license-e2e-observation-1',
    observedAt: new Date('2026-08-03T10:00:00.000Z'),
    activeUsers: 11,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listPendingLicenseUsageObservations.mockResolvedValue([observation]);
    mocks.markLicenseUsageObservationAttempt.mockResolvedValue(undefined);
    mocks.markLicenseUsageObservationDelivered.mockResolvedValue(undefined);
    mocks.syncLicenseWithCloud.mockResolvedValue({ status: 'synced' });
  });

  it('keeps a failed observation pending and delivers the same event on retry', async () => {
    mocks.syncLicenseWithCloud
      .mockResolvedValueOnce({ status: 'failed' })
      .mockResolvedValueOnce({ status: 'synced' });

    await expect(licenseUsageSyncJob()).rejects.toThrow(
      'License usage delivery failed',
    );

    expect(mocks.markLicenseUsageObservationAttempt).toHaveBeenCalledWith(
      observation.id,
    );
    expect(mocks.syncLicenseWithCloud).toHaveBeenCalledWith({
      eventId: observation.id,
      observedAt: observation.observedAt,
      activeUsers: observation.activeUsers,
    });
    expect(mocks.markLicenseUsageObservationDelivered).not.toHaveBeenCalled();

    await expect(licenseUsageSyncJob()).resolves.toBeUndefined();

    expect(mocks.markLicenseUsageObservationAttempt).toHaveBeenCalledTimes(2);
    expect(mocks.syncLicenseWithCloud).toHaveBeenCalledTimes(2);
    expect(mocks.markLicenseUsageObservationDelivered).toHaveBeenCalledTimes(1);
    expect(mocks.markLicenseUsageObservationDelivered).toHaveBeenCalledWith(
      observation.id,
    );
  });
});
