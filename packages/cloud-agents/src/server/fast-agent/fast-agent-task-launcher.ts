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

export type FastAgentTaskLaunchHooks = {
  /**
   * Runs inside the launch gate, after the parent kickoff has been posted and
   * before the child becomes runnable. Throwing cancels the launch.
   */
  afterKickoff?: (
    taskRun: { id: number; taskId: string },
    context: { prompt: string; taskUrl: string },
  ) => Promise<void>;
};

export function createFastAgentTaskLauncher(
  params: {
    userId: string;
    surface: FastAgentSurface;
    taskUrlCampaign: string;
    buildTask: (input: {
      prompt: string;
      environmentId: string | null;
      parentSessionId: string;
    }) => StandardTask | Promise<StandardTask>;
  } & FastAgentTaskLaunchHooks,
): LaunchFastAgentTask {
  return async ({ prompt, environmentId, parentSessionId, postKickoff }) => {
    const task = await params.buildTask({
      prompt,
      environmentId,
      parentSessionId,
    });
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
        beforeEnqueue: async (taskRun) => {
          const resolvedTaskUrl = getTaskUrl({
            taskId: taskRun.taskId,
            utm: {
              source: params.surface,
              campaign: params.taskUrlCampaign,
            },
          });
          taskUrl = resolvedTaskUrl;
          await postKickoff({ taskId: taskRun.taskId, taskUrl });
          await params.afterKickoff?.(
            { id: taskRun.id, taskId: taskRun.taskId },
            { prompt, taskUrl: resolvedTaskUrl },
          );
        },
      },
    );

    if (!launch.taskId) {
      return {
        success: false,
        error: 'The task launch did not return a task ID.',
      };
    }

    return { success: true, taskId: launch.taskId, taskUrl };
  };
}

export type FastAgentSlackTaskLauncherParams = {
  userId: string;
  teamId: string;
  teamDomain?: string;
  channelId: string;
  threadTs: string;
  messageId?: string;
  /** Opt the child into the native Slack task card in the parent thread. */
  liveTaskStream?: boolean;
} & FastAgentTaskLaunchHooks;

export function createFastAgentSlackTaskLauncher(
  params: FastAgentSlackTaskLauncherParams,
): LaunchFastAgentTask {
  return createFastAgentTaskLauncher({
    userId: params.userId,
    surface: 'slack',
    taskUrlCampaign: 'fast-delegation',
    afterKickoff: params.afterKickoff,
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
        ...(params.liveTaskStream ? { liveTaskStream: true } : {}),
        ...(environmentId && environmentId !== ALL_REPOSITORIES
          ? { environmentId }
          : {}),
      },
    }),
  });
}
