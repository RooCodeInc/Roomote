import {
  createFastAgentSlackTaskLauncher,
  type LaunchFastAgentSlackTask,
} from '@roomote/cloud-agents/server';
import { type SlackEvent } from '@roomote/slack';
import {
  type SlackInstallation,
  type SlackUserMapping,
} from '@roomote/db/server';
export function createFastAgentTaskLauncher(params: {
  event: SlackEvent;
  slackInstallation: SlackInstallation;
  userMapping: SlackUserMapping;
  userId: string;
  teamId: string;
}): LaunchFastAgentSlackTask {
  return createFastAgentSlackTaskLauncher({
    userId: params.userId,
    teamId: params.teamId,
    ...(params.slackInstallation.teamDomain
      ? { teamDomain: params.slackInstallation.teamDomain }
      : {}),
    channelId: params.event.channel,
    threadTs: params.event.thread_ts || params.event.ts,
    messageId: params.event.ts,
  });
}
