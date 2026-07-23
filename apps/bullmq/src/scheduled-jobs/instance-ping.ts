import {
  collectInstanceReportStats,
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
 * 2. Anonymous instance stats report (covered by the admin opt-out).
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

  if (!(await isAnonymousAnalyticsEnabled())) {
    console.log(
      `${LOG_PREFIX} instance report skipped: anonymous analytics disabled`,
    );
    return;
  }

  const stats = await collectInstanceReportStats();
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
