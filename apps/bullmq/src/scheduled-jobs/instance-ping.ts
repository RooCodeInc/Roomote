import {
  collectInstanceReportStats,
  collectLicensedUserCount,
  getDeploymentLicenseState,
  recordLatestKnownVersion,
} from '@roomote/db/server';
import {
  checkLatestVersion,
  isAnonymousAnalyticsEnabled,
  isTelemetryEnvAllowed,
  sendInstanceReport,
} from '@roomote/telemetry/server';

const LOG_PREFIX = '[instancePing]';

/**
 * Daily telemetry job:
 * 1. Version check against the Ping service (mandatory; carries only the
 *    anonymous instance id + running version). The result is stored for the
 *    in-app "update available" notice.
 * 2. Instance stats report. Anonymous stats honor the admin opt-out; a valid
 *    paid license reports only its current user count when analytics is off.
 *
 * Sends nothing at all in environments where telemetry is not allowed
 * (non-production / no RELEASE_VERSION, unless force-enabled with an explicit
 * Ping endpoint).
 */
export async function instancePingJob(): Promise<void> {
  if (!isTelemetryEnvAllowed()) {
    console.log(
      `${LOG_PREFIX} skipped: telemetry is not allowed in this environment`,
    );
    return;
  }

  const versionCheck = await checkLatestVersion();
  if (versionCheck?.latestVersion) {
    await recordLatestKnownVersion(versionCheck.latestVersion);
    console.log(
      `${LOG_PREFIX} latest known version: ${versionCheck.latestVersion}`,
    );
  }

  const [analyticsEnabled, licenseState] = await Promise.all([
    isAnonymousAnalyticsEnabled(),
    getDeploymentLicenseState(),
  ]);

  if (!analyticsEnabled && licenseState.status !== 'valid') {
    console.log(
      `${LOG_PREFIX} instance report skipped: anonymous analytics disabled`,
    );
    return;
  }

  const stats = analyticsEnabled
    ? await collectInstanceReportStats()
    : await collectLicensedUserCount();
  const sent = await sendInstanceReport(stats);
  console.log(`${LOG_PREFIX} instance report ${sent ? 'sent' : 'not sent'}`);

  if (!sent) {
    // The daily report is the one telemetry payload worth retrying: it is
    // sent once per day, so a transient Ping blip would otherwise lose a
    // full day's heartbeat. Throwing lets the scheduled-jobs queue's
    // built-in retry (3 attempts, exponential backoff) re-attempt it;
    // duplicate deliveries are deduplicated service-side by instance + day.
    throw new Error('Instance report delivery failed');
  }
}
