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
  buildSlackRichTextValue,
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
        // A task_card BLOCK in an ordinary message, not a stream: the
        // worker re-renders the whole card via chat.update on every event,
        // so the body always shows only the latest state.
        const messageTs = await params.slack.postMessage({
          channel: params.event.channel,
          thread_ts: threadId,
          text: title,
          blocks: [
            {
              type: 'task_card',
              task_id: taskUpdateId,
              title,
              status: 'in_progress',
              details: buildSlackRichTextValue(
                'Delegating to a Roomote agent…',
              ),
              sources: [
                { type: 'url', url: resolvedTaskUrl, text: 'View task' },
              ],
            },
          ],
          unfurl_links: false,
          unfurl_media: false,
        });

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
