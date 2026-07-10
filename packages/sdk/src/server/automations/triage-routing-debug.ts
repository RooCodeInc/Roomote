import { getConfiguredRouterDebugSlackChannelId } from '@roomote/db/server';
import { SlackNotifier } from '@roomote/slack';

export async function postScheduledTriageRoutingDebug(params: {
  automationKey: string;
  slackBotToken: string;
  manualTrigger: boolean;
  outcome: 'queued' | 'skipped';
  taskSlackChannelId?: string | null;
  details?: string;
}): Promise<void> {
  const debugChannelId = await getConfiguredRouterDebugSlackChannelId();

  if (!debugChannelId) {
    return;
  }

  const taskSlackChannelId = params.taskSlackChannelId?.trim() || '(none)';
  const details =
    params.details?.trim() ||
    'Task channel selection left unchanged; this is a diagnostic post only.';

  const text = [
    `Scheduled triage debug | ${params.automationKey}`,
    `trigger: ${params.manualTrigger ? 'manual' : 'scheduled'}`,
    `outcome: ${params.outcome === 'queued' ? 'task queued' : 'skipped'}`,
    `task_slack_channel: ${taskSlackChannelId}`,
    `details: ${details}`,
  ].join('\n');

  try {
    const slack = new SlackNotifier(params.slackBotToken);
    const hasDebugChannelAccess = await slack.isAppInChannel(debugChannelId);

    if (hasDebugChannelAccess !== true) {
      return;
    }

    await slack.postMessage({
      channel: debugChannelId,
      text,
      unfurl_links: false,
      unfurl_media: false,
    });
  } catch (error) {
    console.error(
      `[ScheduledTriageDebug] Failed to post routing debug message: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
