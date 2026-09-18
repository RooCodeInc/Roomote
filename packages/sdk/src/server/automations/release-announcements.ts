import { getAutomationRuntime } from '@roomote/db/server';

import { sendInstalledReleaseAnnouncementTest } from '../lib/release-announcements';
import {
  listConnectedCommunicationProviders,
  resolveAutomationRuntimeDestination,
} from './destination';
import {
  emptyJobResult,
  type AutomationJobResult,
  type AutomationRunOpts,
} from './types';

export async function releaseAnnouncementsJob(
  opts: AutomationRunOpts = {},
): Promise<AutomationJobResult> {
  const result = emptyJobResult();
  const runtime = await getAutomationRuntime('release_announcements');
  if (!runtime.enabled) {
    result.skippedReason = 'Automation is disabled.';
    return result;
  }

  const connectedProviders = opts.destination
    ? []
    : await listConnectedCommunicationProviders();
  const destination =
    opts.destination ??
    (await resolveAutomationRuntimeDestination({
      runtime,
      slackConnected: connectedProviders.includes('slack'),
    }));
  if (!destination) {
    result.skippedReason = 'Announcement destination is not configured.';
    return result;
  }

  const sendResult = await sendInstalledReleaseAnnouncementTest(destination);
  switch (sendResult) {
    case 'sent':
      result.completed = true;
      break;
    case 'no_installed_release':
      result.skippedReason =
        'The installed Roomote release is not recorded yet.';
      break;
    case 'no_previous_release':
      result.skippedReason = 'No previous release is available for comparison.';
      break;
    case 'no_highlights':
      result.skippedReason =
        'The installed release has no authored highlights.';
      break;
  }
  return result;
}
