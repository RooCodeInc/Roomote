import {
  getTaskUrl,
  type LaunchFastAgentSlackTask,
} from '@roomote/cloud-agents/server';
import { startSlackAppMentionTask, type SlackEvent } from '@roomote/slack';
import {
  type SlackInstallation,
  type SlackUserMapping,
} from '@roomote/db/server';
import { ALL_REPOSITORIES } from '@roomote/types';

export function createFastAgentTaskLauncher(params: {
  event: SlackEvent;
  slackInstallation: SlackInstallation;
  userMapping: SlackUserMapping;
  userId: string;
  teamId: string;
}): LaunchFastAgentSlackTask {
  return async ({ prompt, environmentId }) => {
    const threadId = params.event.thread_ts || params.event.ts;
    const launch = await startSlackAppMentionTask({
      initiator: { kind: 'user', userId: params.userId },
      trigger: 'message',
      channel: params.event.channel,
      teamId: params.teamId,
      teamDomain: params.slackInstallation.teamDomain ?? undefined,
      slackUserId: params.event.user ?? params.userMapping.slackUserId,
      persistedSlackUserId: params.userMapping.slackUserId,
      text: prompt,
      ts: params.event.ts,
      threadTs: threadId,
      repo: ALL_REPOSITORIES,
      ...(environmentId ? { environmentId } : {}),
    });

    if (!launch.taskId) {
      return {
        success: false,
        error: 'The task launch did not return a task ID.',
      };
    }

    return {
      success: true,
      taskId: launch.taskId,
      taskUrl: getTaskUrl({
        taskId: launch.taskId,
        utm: { source: 'slack', campaign: 'fast-delegation' },
      }),
    };
  };
}
