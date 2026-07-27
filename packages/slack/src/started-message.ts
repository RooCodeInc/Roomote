import {
  type RoutingDebugInfo,
  getTaskUrl,
} from '@roomote/cloud-agents/server';
import { getRedis } from '@roomote/redis';

import type { SlackBlock } from '@roomote/types';
import { buildSlackThreadPermalink } from '@roomote/types';

import { postRouterDebugMessage } from './router-debug';
import { persistPostedSlackKickoff } from './persist-posted-slack-kickoff';
import { SlackNotifier } from './slack-notifier';
import { buildStartedBlocks } from './started-message-blocks';

function postSlackFinalRouterDebug({
  source,
  sourceLink,
  taskDescription,
  selectedWorkspace,
  reasoning,
  routingDebug,
  routingDurationMs,
  userRoute,
}: {
  source: string;
  sourceLink?: string;
  taskDescription: string;
  selectedWorkspace: { name: string; type: string };
  reasoning?: string;
  routingDebug?: RoutingDebugInfo;
  routingDurationMs?: number;
  userRoute?: string;
}) {
  void postRouterDebugMessage({
    source,
    sourceLink,
    taskDescription,
    selectedWorkspace,
    reasoning: reasoning ?? '',
    routingDebug,
    routingDurationMs,
    userRoute,
  });
}

export function getSlackStartedMessageFollowUrl({
  taskId,
}: {
  taskId?: string | null;
}): string | undefined {
  if (taskId) {
    return getTaskUrl({
      taskId,
      utm: { source: 'slack', campaign: 'follow_task' },
    });
  }

  return undefined;
}

async function updateConfirmToStarted({
  slack,
  channel,
  threadTs,
  confirmMessageTs,
  blocks,
}: {
  slack: SlackNotifier;
  channel: string;
  threadTs: string;
  confirmMessageTs?: string | null;
  blocks: SlackBlock[];
}): Promise<string | undefined> {
  if (confirmMessageTs) {
    const updated = await slack.updateMessage({
      channel,
      ts: confirmMessageTs,
      message: { blocks },
    });

    if (updated) {
      return confirmMessageTs;
    }
  }

  return await slack.postMessage({
    channel,
    thread_ts: threadTs,
    blocks,
  });
}

export async function finishRoutedStart({
  runId,
  taskId,
  taskDescription,
  userId,
  initiatingSlackUserId,
  agentName,
  workspaceDisplayName,
  modelDisplayName,
  kickoffMessage,
  workspaceType,
  workspaceValue,
  workspaceOnly,
  channel,
  threadId,
  teamDomain,
  reasoning,
  routingDebug,
  routingDurationMs,
  userRoute,
  existingMessageTs,
  warningText,
  slack,
}: {
  runId: number | null;
  taskId: string | null;
  taskDescription: string;
  /**
   * Linked launching user, when one exists. Automation-initiated launches
   * (for example bot-authored channel auto-start) have none and skip the
   * per-user last-workspace memory.
   */
  userId?: string | null;
  initiatingSlackUserId?: string;
  agentName: string;
  workspaceDisplayName: string;
  modelDisplayName?: string;
  kickoffMessage?: string;
  workspaceType: 'environment' | 'all_repositories';
  workspaceValue: string;
  workspaceOnly?: boolean;
  channel: string;
  threadId: string;
  teamDomain?: string;
  reasoning?: string;
  routingDebug?: RoutingDebugInfo;
  routingDurationMs?: number;
  userRoute?: string;
  existingMessageTs?: string | null;
  warningText?: string;
  slack: SlackNotifier;
}): Promise<void> {
  postSlackFinalRouterDebug({
    source: `Slack ${channel}`,
    sourceLink:
      buildSlackThreadPermalink({
        slackWorkspaceDomain: teamDomain,
        slackChannelId: channel,
        threadTs: threadId,
      }) ?? undefined,
    taskDescription,
    selectedWorkspace: {
      name: workspaceDisplayName,
      type: workspaceType,
    },
    reasoning,
    routingDebug,
    routingDurationMs,
    userRoute,
  });

  const taskUrl = getSlackStartedMessageFollowUrl({
    taskId,
  });

  const blocks = buildStartedBlocks({
    workspaceDisplayName,
    modelDisplayName,
    kickoffMessage,
    runId,
    taskId,
    initiatingSlackUserId,
    taskUrl,
    warningText,
  });

  const startedMessageTs = existingMessageTs
    ? await updateConfirmToStarted({
        slack,
        channel,
        threadTs: threadId,
        confirmMessageTs: existingMessageTs,
        blocks,
      })
    : await slack.postMessage({
        channel,
        thread_ts: threadId,
        blocks,
      });

  if (startedMessageTs && runId) {
    await persistPostedSlackKickoff({
      runId,
      taskId,
      messageTs: startedMessageTs,
      agentName,
      initiatingSlackUserId,
      workspaceDisplayName,
      modelDisplayName,
      kickoffMessage,
      workspaceOnly,
      warningText,
    });
  }

  if (userId) {
    const lastWorkspaceKey = `last_workspace:${userId}`;
    await getRedis().set(
      lastWorkspaceKey,
      workspaceValue,
      'EX',
      30 * 24 * 60 * 60,
    );
  }
}
