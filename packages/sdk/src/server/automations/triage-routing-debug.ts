import { postRouterDebugText } from '@roomote/slack';

export async function postScheduledTriageRoutingDebug(params: {
  automationKey: string;
  slackBotToken: string;
  manualTrigger: boolean;
  outcome: 'queued' | 'skipped';
  taskSlackChannelId?: string | null;
  details?: string;
}): Promise<void> {
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

  await postRouterDebugText(text);
}
