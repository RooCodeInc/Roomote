import {
  ALL_REPOSITORIES,
  buildFastAgentChildTaskMetadata,
  buildSlackThreadPermalink,
  TaskPayloadKind,
  type StandardTask,
  type TaskInitiator,
  type TaskSurface,
  type TaskTrigger,
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
  /** Runs when queueing fails after afterKickoff completed. */
  onQueueFailure?: (taskRun: { id: number; taskId: string }) => Promise<void>;
  /** The launcher renders the task link itself (for example on a card), so
   * the parent kickoff message should not include one. */
  rendersTaskLink?: boolean;
};

export function createFastAgentTaskLauncher(
  params: {
    userId: string;
    surface: TaskSurface;
    initiator?: TaskInitiator;
    trigger?: TaskTrigger;
    taskUrlCampaign: string;
    buildTask: (input: {
      prompt: string;
      environmentId: string | null;
      model?: string | null;
      parentSessionId: string;
    }) => StandardTask | Promise<StandardTask>;
  } & FastAgentTaskLaunchHooks,
): LaunchFastAgentTask {
  return async ({
    prompt,
    environmentId,
    model,
    parentSessionId,
    postKickoff,
  }) => {
    const task = await params.buildTask({
      prompt,
      environmentId,
      model,
      parentSessionId,
    });
    let taskUrl: string | undefined;
    let preparedTaskRun: { id: number; taskId: string } | undefined;

    const launch = await enqueueTask(
      {
        task,
        initiator: params.initiator ?? { kind: 'user', userId: params.userId },
        workflow: 'standard',
        surface: params.surface,
        trigger: params.trigger ?? 'message',
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
          await postKickoff({
            taskId: taskRun.taskId,
            taskUrl,
            ...(params.rendersTaskLink ? { taskLinkRendered: true } : {}),
          });
          await params.afterKickoff?.(
            { id: taskRun.id, taskId: taskRun.taskId },
            { prompt, taskUrl: resolvedTaskUrl },
          );
          preparedTaskRun = { id: taskRun.id, taskId: taskRun.taskId };
        },
      },
    ).catch(async (error: unknown) => {
      if (preparedTaskRun && params.onQueueFailure) {
        try {
          await params.onQueueFailure(preparedTaskRun);
        } catch (settleError) {
          console.error(
            `[Fast Agent] Failed to settle task ${preparedTaskRun.taskId} after queueing failed: ${settleError instanceof Error ? settleError.message : String(settleError)}`,
          );
        }
      }
      throw error;
    });

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
  const slackConversationUrl = buildSlackThreadPermalink({
    slackWorkspaceDomain: params.teamDomain,
    slackTeamId: params.teamId,
    slackChannelId: params.channelId,
    threadTs: params.threadTs,
    messageTs: params.messageId,
  });

  return createFastAgentTaskLauncher({
    userId: params.userId,
    surface: 'slack',
    taskUrlCampaign: 'fast-delegation',
    afterKickoff: params.afterKickoff,
    onQueueFailure: params.onQueueFailure,
    rendersTaskLink: params.rendersTaskLink,
    buildTask: ({ prompt, environmentId, model, parentSessionId }) => ({
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
        ...(slackConversationUrl ? { slackConversationUrl } : {}),
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
        ...(model
          ? { harnessModelOverrides: { 'opencode-server': model } }
          : {}),
      },
    }),
  });
}

export function createFastAgentWebTaskLauncher(params: {
  userId: string;
  conversation: {
    surface: 'web';
    workspaceId: string;
    conversationId: string;
  };
}): LaunchFastAgentTask {
  return createFastAgentTaskLauncher({
    userId: params.userId,
    surface: 'web',
    taskUrlCampaign: 'fast-delegation',
    buildTask: ({ prompt, environmentId, model, parentSessionId }) => ({
      type: TaskPayloadKind.StandardTask,
      payload: {
        repo: ALL_REPOSITORIES,
        description: prompt,
        ...buildFastAgentChildTaskMetadata({
          sessionId: parentSessionId,
          conversation: params.conversation,
        }),
        ...(environmentId && environmentId !== ALL_REPOSITORIES
          ? { environmentId }
          : {}),
        ...(model
          ? { harnessModelOverrides: { 'opencode-server': model } }
          : {}),
      },
    }),
  });
}
