import { getAutomationRuntime } from '@roomote/db/server';

import { sendReleaseAnnouncementTest } from '../lib/release-announcements';
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

  const sendResult = await sendReleaseAnnouncementTest(destination);
  switch (sendResult) {
    case 'sent':
      result.completed = true;
      break;
    case 'no_release_notes':
      result.skippedReason =
        'No stable major or minor release notes are available.';
      break;
    case 'no_highlights':
      result.skippedReason =
        'The selected release has no authored summary or highlights.';
      break;
  }
  return result;
}
