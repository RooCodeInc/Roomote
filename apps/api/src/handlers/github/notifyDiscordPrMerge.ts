import { DiscordCommunicationProvider } from '@roomote/communication/discord-provider';
import {
  buildPullRequestMergedNotificationText,
  formatMarkdownLink,
} from '@roomote/communication/chat-messages';
import {
  and,
  db,
  eq,
  githubInstallations,
  inArray,
  resolveDiscordRuntimeCredentials,
  taskPullRequests,
  taskRuns,
} from '@roomote/db/server';
import {
  getCommunicationChannelFromTaskPayload,
  getCommunicationProviderFromTaskPayload,
  getCommunicationThreadIdFromTaskPayload,
  type SourceControlProvider,
} from '@roomote/types';

interface NotifyDiscordPrMergeParams {
  sourceControlProvider: SourceControlProvider;
  /**
   * GitHub App installation gate. Omitted for non-GitHub providers, whose
   * handlers verify the repository is tracked before calling this notifier.
   */
  installationId?: number;
  repository: string;
  prNumber: number;
  prTitle: string;
  prUrl: string;
  mergedBy: string;
}

type DiscordPrMergeTarget = {
  channelId: string;
  threadId?: string;
};

function getDiscordPrMergeTarget(
  payload: unknown,
): DiscordPrMergeTarget | null {
  if (
    !payload ||
    typeof payload !== 'object' ||
    getCommunicationProviderFromTaskPayload(payload) !== 'discord'
  ) {
    return null;
  }

  const channelId = getCommunicationChannelFromTaskPayload(payload);

  if (!channelId) {
    return null;
  }

  const threadId = getCommunicationThreadIdFromTaskPayload(payload);

  return {
    channelId,
    ...(threadId ? { threadId } : {}),
  };
}

/**
 * Posts a PR-merged notification to each unique Discord conversation linked
 * to the PR. Discord task threads are addressed directly rather than using a
 * message reply, keeping the notification visually native to the thread.
 */
export async function notifyDiscordPrMerge({
  sourceControlProvider,
  installationId,
  repository,
  prNumber,
  prTitle,
  prUrl,
  mergedBy,
}: NotifyDiscordPrMergeParams): Promise<void> {
  try {
    if (installationId !== undefined) {
      const githubInstallation = await db.query.githubInstallations.findFirst({
        where: eq(githubInstallations.installationId, installationId),
        columns: { id: true },
      });

      if (!githubInstallation) {
        console.warn(
          `[notifyDiscordPrMerge] No GitHub installation found for installationId ${installationId}`,
        );
        return;
      }
    }

    const prTaskLinks = await db.query.taskPullRequests.findMany({
      where: and(
        eq(taskPullRequests.sourceControlProvider, sourceControlProvider),
        eq(taskPullRequests.repository, repository),
        eq(taskPullRequests.prNumber, prNumber),
      ),
      columns: { taskId: true },
    });
    const taskIds = Array.from(new Set(prTaskLinks.map((link) => link.taskId)));

    if (taskIds.length === 0) {
      return;
    }

    const linkedRuns = await db.query.taskRuns.findMany({
      where: inArray(taskRuns.taskId, taskIds),
      columns: { payload: true },
    });
    const targets = linkedRuns
      .map((run) => getDiscordPrMergeTarget(run.payload))
      .filter((target): target is DiscordPrMergeTarget => target !== null);

    if (targets.length === 0) {
      return;
    }

    const { botToken, applicationId } =
      await resolveDiscordRuntimeCredentials();

    if (!botToken) {
      console.warn(
        '[notifyDiscordPrMerge] Discord bot credentials are not configured, skipping Discord PR-merge notification',
      );
      return;
    }

    const provider = new DiscordCommunicationProvider({
      botToken,
      ...(applicationId ? { applicationId } : {}),
    });
    const mergeNotification = buildPullRequestMergedNotificationText({
      prTitle,
      prUrl,
      mergedBy,
      formatLink: formatMarkdownLink,
      formatStatus: (status) => `**${status}**`,
    });
    const notifiedConversations = new Set<string>();

    for (const target of targets) {
      const conversationKey = `${target.channelId}:${target.threadId ?? ''}`;

      if (notifiedConversations.has(conversationKey)) {
        continue;
      }

      notifiedConversations.add(conversationKey);

      try {
        await provider.postMessage({
          channelId: target.channelId,
          ...(target.threadId ? { threadId: target.threadId } : {}),
          text: mergeNotification.bodyText,
          textFormat: 'markdown',
        });

        console.log(
          `[notifyDiscordPrMerge] Sent notification to Discord conversation ${conversationKey} for PR ${repository}#${prNumber}`,
        );
      } catch (error) {
        console.error(
          `[notifyDiscordPrMerge] Failed to send Discord notification for conversation ${conversationKey}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  } catch (error) {
    console.error(
      `[notifyDiscordPrMerge] Error notifying Discord conversations for PR ${repository}#${prNumber}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
