import {
  ALL_REPOSITORIES,
  buildFastAgentChildTaskMetadata,
  TaskPayloadKind,
  type FastAgentSurface,
  type StandardTask,
} from '@roomote/types';

import { enqueueTask } from '../task-run-queue';
import { getTaskUrl } from '../task-url';
import type { LaunchFastAgentTask } from './fast-agent-conversation';

export function createFastAgentTaskLauncher(params: {
  userId: string;
  surface: FastAgentSurface;
  taskUrlCampaign: string;
  buildTask: (input: {
    prompt: string;
    environmentId: string | null;
    parentSessionId: string;
  }) => StandardTask | Promise<StandardTask>;
}): LaunchFastAgentTask {
  return async ({
    prompt,
    environmentId,
    parentSessionId,
    signal,
    postKickoff,
  }) => {
    signal?.throwIfAborted();
    const task = await params.buildTask({
      prompt,
      environmentId,
      parentSessionId,
    });
    signal?.throwIfAborted();
    let taskUrl: string | undefined;
    const launch = await enqueueTask(
      {
        task,
        initiator: { kind: 'user', userId: params.userId },
        workflow: 'standard',
        surface: params.surface,
        trigger: 'message',
      },
      {
        signal,
        beforeEnqueue: async (taskRun) => {
          signal?.throwIfAborted();
          taskUrl = getTaskUrl({
            taskId: taskRun.taskId,
            utm: {
              source: params.surface,
              campaign: params.taskUrlCampaign,
            },
          });
          await postKickoff({ taskId: taskRun.taskId, taskUrl });
          signal?.throwIfAborted();
        },
      },
    );

    return launch.taskId
      ? { success: true, taskId: launch.taskId, taskUrl }
      : { success: false, error: 'The task launch did not return a task ID.' };
  };
}

export function createFastAgentSlackTaskLauncher(params: {
  userId: string;
  teamId: string;
  teamDomain?: string;
  channelId: string;
  threadTs: string;
  messageId?: string;
}): LaunchFastAgentTask {
  return createFastAgentTaskLauncher({
    userId: params.userId,
    surface: 'slack',
    taskUrlCampaign: 'fast-delegation',
    buildTask: ({ prompt, environmentId, parentSessionId }) => ({
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
        ...buildFastAgentChildTaskMetadata({
          sessionId: parentSessionId,
          conversation: {
            surface: 'slack',
            workspaceId: params.teamId,
            conversationId: params.threadTs,
            replyTarget: {
              channelId: params.channelId,
              threadId: params.threadTs,
            },
          },
        }),
        ...(environmentId && environmentId !== ALL_REPOSITORIES
          ? { environmentId }
          : {}),
      },
    }),
  });
}
