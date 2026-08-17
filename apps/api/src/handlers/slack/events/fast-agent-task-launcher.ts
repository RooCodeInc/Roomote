import {
  enqueueTask,
  getTaskUrl,
  type LaunchFastAgentSlackTask,
} from '@roomote/cloud-agents/server';
import {
  buildSlackLiveTaskTitle,
  getSlackLiveTaskStreamData,
  setSlackLiveTaskStreamData,
  type SlackEvent,
  type SlackNotifier,
} from '@roomote/slack';
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
  slack: SlackNotifier;
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
        fastAgentParent: {
          sessionId: parentSessionId,
          slackTeamId: params.teamId,
          slackChannel: params.event.channel,
          slackThreadTs: threadId,
        },
        liveTaskStream: true,
        ...(environmentId && environmentId !== ALL_REPOSITORIES
          ? { environmentId }
          : {}),
      },
    };
    let taskUrl: string | undefined;

    const startLiveTaskStream = async (taskRun: {
      id: number;
      taskId: string;
    }): Promise<void> => {
      try {
        // A card for this task already exists (for example an idempotent
        // relaunch of the same task); keep updating it instead of starting
        // a second stream in the thread.
        if (await getSlackLiveTaskStreamData(taskRun.taskId)) {
          return;
        }

        const resolvedTaskUrl =
          taskUrl ??
          getTaskUrl({
            taskId: taskRun.taskId,
            utm: { source: 'slack', campaign: 'fast-delegation' },
          });
        const title = buildSlackLiveTaskTitle(prompt);
        const taskUpdateId = `roomote-task-${taskRun.taskId}`;
        // One entry whose title always shows the CURRENT step (the worker
        // title-swaps it per todo; only title/status replace on append).
        // The task link is sent exactly once (Slack accumulates sources),
        // and the settled card returns to the task title with the output.
        const initialTask = {
          id: taskUpdateId,
          title,
          // A pending-only stream does not render; start in_progress so the
          // card is visible with the kickoff instead of materializing only
          // at the worker's first update.
          status: 'in_progress' as const,
          sources: [
            { type: 'url' as const, url: resolvedTaskUrl, text: 'View task' },
          ],
        };
        const messageTs = await params.slack.startTaskStream({
          channel: params.event.channel,
          threadTs: threadId,
          recipientTeamId: params.teamId,
          recipientUserId: params.event.user ?? params.userMapping.slackUserId,
          task: initialTask,
        });

        if (messageTs) {
          // The Slack client does not paint a stream whose only content is
          // the opening chunk; re-append the entry so the card renders
          // immediately instead of waiting for the worker's first update.
          // Sources are deliberately omitted: Slack appends them per chunk
          // instead of replacing, so the link is sent exactly once.
          await params.slack.appendTaskStream({
            channel: params.event.channel,
            messageTs,
            task: {
              id: initialTask.id,
              title: initialTask.title,
              status: initialTask.status,
            },
          });
        }

        if (messageTs) {
          await setSlackLiveTaskStreamData(taskRun.taskId, {
            channel: params.event.channel,
            messageTs,
            taskId: taskRun.taskId,
            taskUpdateId,
            threadTs: threadId,
            title,
            taskUrl: resolvedTaskUrl,
          });
        }
      } catch (error) {
        console.error(
          `[Fast Agent] Failed to start Slack live task stream for run ${taskRun.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };

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
          await startLiveTaskStream(taskRun);
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
