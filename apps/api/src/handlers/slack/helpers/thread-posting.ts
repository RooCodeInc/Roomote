import { Env } from '@roomote/env';
import { AGENT_DISPLAY_NAME, formatErrorForLog } from '@roomote/types';
import {
  findSlackConversationSubjectByUserId,
  recordSlackConversationMessageBestEffort,
} from '@roomote/sdk/server';
import {
  buildStartedBlocks,
  persistPostedSlackKickoff,
  type SlackNotifier,
} from '@roomote/slack';

import { apiLogger } from '../../../logging.js';

type SlackThreadMarkdownPostResult = 'posted' | 'suppressed' | 'failed';

export async function postSlackThreadMarkdownMessage({
  slack,
  channel,
  threadTs,
  text,
  sourceMessageTs,
  conversationLog,
}: {
  slack: SlackNotifier;
  channel: string;
  threadTs: string;
  text: string;
  sourceMessageTs?: string;
  conversationLog?: {
    userId: string;
    slackTeamId: string;
    source: string;
  };
}): Promise<SlackThreadMarkdownPostResult> {
  if (sourceMessageTs) {
    const sourceMessageExists = await slack.hasMessageInThread({
      channel,
      threadTs,
      messageTs: sourceMessageTs,
    });

    if (sourceMessageExists === false) {
      apiLogger.debug(
        `[SlackWebhook] Skipping fast-agent reply because source message ${sourceMessageTs} is no longer in thread ${threadTs}`,
      );
      // Deliberate suppression (the triggering message was deleted), not a
      // Slack delivery failure; callers must not treat this as an error.
      return 'suppressed';
    }
  }

  const messageTs = await slack.postMessage({
    channel,
    thread_ts: threadTs,
    text,
    blocks: [
      {
        type: 'markdown',
        text,
      },
    ],
  });

  if (!messageTs) {
    return 'failed';
  }

  if (conversationLog) {
    const subject = await findSlackConversationSubjectByUserId({
      userId: conversationLog.userId,
      slackTeamId: conversationLog.slackTeamId,
    });

    if (subject) {
      await recordSlackConversationMessageBestEffort({
        logContext: 'SlackWebhook.threadReply',
        ...subject,
        senderSlackUserId: null,
        slackChannelId: channel,
        conversationKind: 'thread',
        threadTs,
        messageTs,
        direction: 'outbound',
        authorKind: 'roomote',
        source: conversationLog.source,
        text,
      });
    }
  }

  return 'posted';
}

export async function postTaskSuggestionStartedMessage(params: {
  slack: SlackNotifier;
  channelId: string;
  threadTs: string;
  workspaceName: string;
  runId: number | null;
  initiatingSlackUserId: string;
  taskId: string | null;
  readinessNote?: string;
}): Promise<void> {
  const {
    slack,
    channelId,
    threadTs,
    workspaceName,
    runId,
    initiatingSlackUserId,
    taskId,
    readinessNote,
  } = params;

  const taskUrl = taskId ? new URL(`/task/${taskId}`, Env.R_APP_URL) : null;

  if (taskUrl) {
    taskUrl.searchParams.set('utm_source', 'slack');
    taskUrl.searchParams.set('utm_medium', 'integration');
    taskUrl.searchParams.set('utm_campaign', 'setup_suggestion_reaction');
  }

  try {
    const startedMessageTs = await slack.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      blocks: buildStartedBlocks({
        workspaceDisplayName: workspaceName,
        runId,
        taskId,
        initiatingSlackUserId,
        taskUrl: taskUrl?.toString(),
        readinessNote,
      }),
    });

    if (startedMessageTs && runId) {
      await persistPostedSlackKickoff({
        runId,
        taskId,
        messageTs: startedMessageTs,
        agentName: AGENT_DISPLAY_NAME,
        initiatingSlackUserId,
        workspaceDisplayName: workspaceName,
        workspaceOnly: false,
      });
    }
  } catch (error) {
    console.warn(
      `[SlackWebhook] Failed to post task suggestion started message for ${channelId}:${threadTs}: ${formatErrorForLog(error)}`,
    );
  }
}
