import {
  db,
  githubInstallations,
  taskPullRequests,
  taskRuns,
  eq,
  and,
  inArray,
} from '@roomote/db/server';
import {
  buildPullRequestMergedNotificationText,
  formatMarkdownLink,
} from '@roomote/communication/chat-messages';
import { createTeamsCommunicationProviderFromRuntimeCredentials } from '@roomote/sdk/server';
import {
  getCommunicationChannelFromTaskPayload,
  getCommunicationProviderFromTaskPayload,
  getCommunicationServiceUrlFromTaskPayload,
  getCommunicationThreadIdFromTaskPayload,
  type SourceControlProvider,
} from '@roomote/types';

interface NotifyTeamsPrMergeParams {
  /**
   * Source control provider that owns the merged PR/MR. Used to scope the
   * task-link lookup so the correct provider's tracked PRs are notified.
   */
  sourceControlProvider: SourceControlProvider;
  /**
   * GitHub App installation gate. Omitted for non-GitHub providers (for
   * example GitLab), whose handlers verify the repository is tracked before
   * calling this notifier.
   */
  installationId?: number;
  repository: string;
  prNumber: number;
  prTitle: string;
  prUrl: string;
  mergedBy: string;
}

type TeamsPrMergeTarget = {
  channelId: string;
  serviceUrl: string;
  threadId?: string;
};

function getTeamsPrMergeTarget(payload: unknown): TeamsPrMergeTarget | null {
  if (
    !payload ||
    typeof payload !== 'object' ||
    getCommunicationProviderFromTaskPayload(payload) !== 'teams'
  ) {
    return null;
  }

  const channelId = getCommunicationChannelFromTaskPayload(payload);
  const serviceUrl = getCommunicationServiceUrlFromTaskPayload(payload);

  if (!channelId || !serviceUrl) {
    return null;
  }

  const threadId = getCommunicationThreadIdFromTaskPayload(payload);

  return {
    channelId,
    serviceUrl,
    ...(threadId ? { threadId } : {}),
  };
}

/**
 * Notifies Microsoft Teams conversations associated with a PR that the PR has
 * been merged. Mirrors the Slack PR-merge notification path using the
 * provider-neutral Teams communication metadata on task run payloads.
 */
export async function notifyTeamsPrMerge({
  sourceControlProvider,
  installationId,
  repository,
  prNumber,
  prTitle,
  prUrl,
  mergedBy,
}: NotifyTeamsPrMergeParams): Promise<void> {
  try {
    if (installationId !== undefined) {
      // Verify this GitHub installation is tracked.
      const githubInstallation = await db.query.githubInstallations.findFirst({
        where: eq(githubInstallations.installationId, installationId),
        columns: {
          id: true,
        },
      });

      if (!githubInstallation) {
        console.warn(
          `[notifyTeamsPrMerge] No GitHub installation found for installationId ${installationId}`,
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
      columns: {
        taskId: true,
      },
    });

    const taskIds = Array.from(new Set(prTaskLinks.map((link) => link.taskId)));

    if (taskIds.length === 0) {
      return;
    }

    const linkedRuns = await db.query.taskRuns.findMany({
      where: inArray(taskRuns.taskId, taskIds),
      columns: {
        payload: true,
      },
    });

    const targets = linkedRuns
      .map((job) => getTeamsPrMergeTarget(job.payload))
      .filter((target): target is TeamsPrMergeTarget => target !== null);

    if (targets.length === 0) {
      return;
    }

    const provider =
      await createTeamsCommunicationProviderFromRuntimeCredentials();

    if (!provider) {
      console.warn(
        '[notifyTeamsPrMerge] Teams bot credentials are not configured, skipping Teams PR-merge notification',
      );
      return;
    }

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

      try {
        await provider.postMessage({
          channelId: target.channelId,
          serviceUrl: target.serviceUrl,
          ...(target.threadId
            ? {
                threadId: target.threadId,
                replyToMessageId: target.threadId,
              }
            : {}),
          text: mergeNotification.bodyText,
          textFormat: 'markdown',
        });

        notifiedConversations.add(conversationKey);

        console.log(
          `[notifyTeamsPrMerge] Sent notification to Teams conversation ${conversationKey} for PR ${repository}#${prNumber}`,
        );
      } catch (error) {
        console.error(
          `[notifyTeamsPrMerge] Failed to send Teams notification for conversation ${conversationKey}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  } catch (error) {
    console.error(
      `[notifyTeamsPrMerge] Error notifying Teams conversations for PR ${repository}#${prNumber}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
