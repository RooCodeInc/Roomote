import { stripLeadingRawSlackMention } from '@roomote/cloud-agents';
import {
  findActiveSlackTaskRun,
  findActiveSlackTaskRunByChannel,
  type SlackEvent,
  type SlackNotifier,
} from '@roomote/slack';

import { startTaskGoal } from '../tasks/startTaskGoal.js';
import { postSlackThreadMarkdownMessage } from './helpers/thread-posting.js';

const SLACK_GOAL_COMMAND_PATTERN = /^\/?goal(?:\s+([\s\S]*))?$/iu;

export type SlackGoalCommand = { objective: string };

export function parseSlackGoalCommand(text: string): SlackGoalCommand | null {
  const commandText = stripLeadingRawSlackMention(text).trim();
  const match = SLACK_GOAL_COMMAND_PATTERN.exec(commandText);

  return match ? { objective: (match[1] ?? '').trim() } : null;
}

export async function findSlackGoalCommandTask(
  event: SlackEvent,
  teamId: string,
) {
  if (event.channel_type === 'im' && !event.thread_ts) {
    return findActiveSlackTaskRunByChannel(event.channel, {
      slackTeamId: teamId,
    });
  }

  return findActiveSlackTaskRun(event.thread_ts || event.ts, {
    slackTeamId: teamId,
  });
}

export async function processSlackGoalCommand(input: {
  event: SlackEvent;
  slack: SlackNotifier;
  teamId: string;
  userId: string;
  taskId: string | null;
  threadTs: string;
  command: SlackGoalCommand;
}): Promise<void> {
  let responseText: string;

  if (!input.command.objective) {
    responseText = 'Add what you want me to keep working toward after `goal`.';
  } else if ((input.event.files?.length ?? 0) > 0) {
    responseText = 'Goal Mode does not support attachments.';
  } else if (!input.taskId) {
    responseText =
      'Use `goal <objective>` in an active task thread or DM. Start a task by mentioning me first.';
  } else {
    try {
      const result = await startTaskGoal({
        taskId: input.taskId,
        userId: input.userId,
        objective: input.command.objective,
        source: 'slack',
        clientMessageId: input.event.ts,
      });
      responseText = result.success ? 'Goal Mode enabled.' : result.error;
    } catch (error) {
      console.error(
        `Failed to enable Goal Mode for Slack task ${input.taskId}:`,
        error instanceof Error ? error.message : String(error),
      );
      responseText = 'I could not enable Goal Mode. Try again in a moment.';
    }
  }

  await postSlackThreadMarkdownMessage({
    slack: input.slack,
    channel: input.event.channel,
    threadTs: input.threadTs,
    text: responseText,
    sourceMessageTs: input.event.ts,
    conversationLog: {
      userId: input.userId,
      slackTeamId: input.teamId,
      source: 'slack_goal_command',
    },
  });
}
