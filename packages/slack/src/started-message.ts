import {
  type RoutingDebugInfo,
  getTaskUrl,
} from '@roomote/cloud-agents/server';
import { getRedis } from '@roomote/redis';

import type { SlackBlock } from '@roomote/types';
import { buildSlackThreadPermalink } from '@roomote/types';

import { postRouterDebugMessage } from './router-debug';
import { setSlackStartedMessageTs } from './slack-messages';
import { SlackNotifier } from './slack-notifier';
import { buildStartedBlocks } from './started-message-blocks';

function postSlackFinalRouterDebug({
  source,
  sourceLink,
  taskDescription,
  selectedAgent,
  selectedWorkspace,
  reasoning,
  routingDebug,
  routingDurationMs,
  userRoute,
}: {
  source: string;
  sourceLink?: string;
  taskDescription: string;
  selectedAgent: { name: string; type: string };
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
    selectedAgent,
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
  cloudJobId,
  taskId,
  taskDescription,
  userId,
  initiatingSlackUserId,
  agentName,
  workspaceDisplayName,
  modelDisplayName,
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
  slack,
}: {
  cloudJobId: number | null;
  taskId: string | null;
  taskDescription: string;
  userId: string;
  initiatingSlackUserId?: string;
  agentName: string;
  workspaceDisplayName: string;
  modelDisplayName?: string;
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
    selectedAgent: {
      name: agentName,
      type: agentName,
    },
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
    cloudJobId,
    taskId,
    initiatingSlackUserId,
    taskUrl,
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

  if (startedMessageTs && cloudJobId) {
    await setSlackStartedMessageTs(cloudJobId, startedMessageTs, {
      agentName,
      initiatingSlackUserId,
      workspaceDisplayName,
      ...(modelDisplayName ? { modelDisplayName } : {}),
      workspaceOnly,
    });
  }

  const lastWorkspaceKey = `last_workspace:${userId}`;
  await getRedis().set(
    lastWorkspaceKey,
    workspaceValue,
    'EX',
    30 * 24 * 60 * 60,
  );
}
