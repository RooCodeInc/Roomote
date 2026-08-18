import {
  ALL_REPOSITORIES,
  TaskPayloadKind,
  type StandardTask,
} from '@roomote/types';

import { enqueueTask } from '../task-run-queue';
import { getTaskUrl } from '../task-url';
import type { LaunchFastAgentTask } from './fast-agent-conversation';

export function createFastAgentSlackTaskLauncher(params: {
  userId: string;
  teamId: string;
  teamDomain?: string;
  channelId: string;
  threadTs: string;
  messageId?: string;
}): LaunchFastAgentTask {
  return async ({ prompt, environmentId, parentSessionId, postKickoff }) => {
    const task: StandardTask = {
      type: TaskPayloadKind.StandardTask,
      payload: {
        repo: ALL_REPOSITORIES,
        description: prompt,
        communicationProvider: 'slack',
        communicationTeamId: params.teamId,
        ...(params.teamDomain
          ? { communicationTeamDomain: params.teamDomain }
          : {}),
        communicationChannelId: params.channelId,
        communicationThreadId: params.threadTs,
        ...(params.messageId
          ? { communicationMessageId: params.messageId }
          : {}),
        communicationContextInherited: true,
        fastAgentSessionId: parentSessionId,
        fastAgentParent: {
          sessionId: parentSessionId,
          conversation: {
            surface: 'slack',
            workspaceId: params.teamId,
            channelId: params.channelId,
            threadId: params.threadTs,
          },
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
