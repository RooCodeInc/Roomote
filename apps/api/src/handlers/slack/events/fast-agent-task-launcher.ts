import {
  enqueueTask,
  getTaskUrl,
  type LaunchFastAgentSlackTask,
} from '@roomote/cloud-agents/server';
import { type SlackEvent } from '@roomote/slack';
import {
  type SlackInstallation,
  type SlackUserMapping,
} from '@roomote/db/server';
import {
  ALL_REPOSITORIES,
  TaskPayloadKind,
  type StandardTask,
} from '@roomote/types';

export function createFastAgentTaskLauncher(params: {
  event: SlackEvent;
  slackInstallation: SlackInstallation;
  userMapping: SlackUserMapping;
  userId: string;
  teamId: string;
}): LaunchFastAgentSlackTask {
  return async ({ prompt, environmentId, parentSessionId, postKickoff }) => {
    const threadId = params.event.thread_ts || params.event.ts;
    const task: StandardTask = {
      type: TaskPayloadKind.StandardTask,
      payload: {
        repo: ALL_REPOSITORIES,
        description: prompt,
        communicationProvider: 'slack',
        communicationTeamId: params.teamId,
        communicationTeamDomain:
          params.slackInstallation.teamDomain ?? undefined,
        communicationChannelId: params.event.channel,
        communicationThreadId: threadId,
        communicationMessageId: params.event.ts,
        communicationContextInherited: true,
        fastAgentSessionId: parentSessionId,
        fastAgentParent: {
          sessionId: parentSessionId,
          slackTeamId: params.teamId,
          slackChannel: params.event.channel,
          slackThreadTs: threadId,
        },
        ...(environmentId && environmentId !== ALL_REPOSITORIES
          ? { environmentId }
          : {}),
      },
    };
    let taskUrl: string | undefined;
    const launch = await enqueueTask(
      {
        task,
        initiator: { kind: 'user', userId: params.userId },
        workflow: 'standard',
        surface: 'slack',
        trigger: 'message',
      },
      {
        beforeEnqueue: async (taskRun) => {
          taskUrl = getTaskUrl({
            taskId: taskRun.taskId,
            utm: { source: 'slack', campaign: 'fast-delegation' },
          });
          await postKickoff({ taskId: taskRun.taskId, taskUrl });
        },
      },
    );

    if (!launch.taskId) {
      return {
        success: false,
        error: 'The task launch did not return a task ID.',
      };
    }

    return {
      success: true,
      taskId: launch.taskId,
      taskUrl,
    };
  };
}
