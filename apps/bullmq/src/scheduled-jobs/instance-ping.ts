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
 * Daily job:
 * 1. Version check against GitHub Releases. The result is stored for the
 *    in-app "update available" notice.
 * 2. Anonymous instance stats report, sent only by Roomote Cloud deployments.
 *
 * Does nothing in environments where telemetry is not allowed (non-production
 * or no RELEASE_VERSION, unless force-enabled).
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
      `${LOG_PREFIX} instance report skipped: not a Roomote Cloud deployment`,
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
