import {
  listPendingLicenseUsageObservations,
  markLicenseUsageObservationAttempt,
  markLicenseUsageObservationDelivered,
  recordDailyLicenseUsageObservation,
} from '@roomote/db/server';
import { syncLicenseWithCloud } from '@roomote/telemetry/server';

/** Drains durable self-hosted license usage observations to Roomote Cloud. */
export async function licenseUsageSyncJob(options?: {
  heartbeat?: boolean;
}): Promise<void> {
  if (options?.heartbeat) {
    await recordDailyLicenseUsageObservation();
  }

  let transientFailure = false;
  for (const observation of await listPendingLicenseUsageObservations()) {
    await markLicenseUsageObservationAttempt(observation.id);
    const result = await syncLicenseWithCloud({
      eventId: observation.id,
      observedAt: observation.observedAt,
      activeUsers: observation.activeUsers,
    });

    if (result.status === 'synced' || result.status === 'not_licensed') {
      await markLicenseUsageObservationDelivered(observation.id);
      continue;
    }

    if (result.status === 'license_in_use' || result.status === 'rejected') {
      console.warn(
        `[license-usage] observation ${observation.id} was rejected (${result.status})`,
      );
      await markLicenseUsageObservationDelivered(observation.id);
      continue;
    }

    transientFailure = true;
  }

  if (transientFailure) {
    throw new Error('License usage delivery failed');
  }
}
