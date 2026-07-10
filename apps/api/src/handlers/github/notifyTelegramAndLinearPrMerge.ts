import {
  db,
  githubInstallations,
  taskPullRequests,
  taskRuns,
  tasks,
  eq,
  and,
  inArray,
  isNotNull,
} from '@roomote/db/server';
import {
  buildPullRequestMergedNotificationText,
  formatMarkdownLink,
} from '@roomote/communication/chat-messages';
import { createLinearClient } from '@roomote/linear';
import {
  findLinearDeploymentMcpConnection,
  getValidAccessToken,
} from '@roomote/sdk/server';
import {
  type SourceControlProvider,
  getCommunicationChannelFromTaskPayload,
  getCommunicationMessageIdFromTaskPayload,
  getCommunicationProviderFromTaskPayload,
  getCommunicationThreadIdFromTaskPayload,
} from '@roomote/types';

import { postTelegramMessageBestEffort } from '../telegram/replies';

interface NotifyTelegramAndLinearPrMergeParams {
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

type TelegramPrMergeTarget = {
  chatId: string;
  threadId?: string;
  replyToMessageId?: string;
};

function getTelegramPrMergeTarget(
  payload: unknown,
): TelegramPrMergeTarget | null {
  if (
    !payload ||
    typeof payload !== 'object' ||
    getCommunicationProviderFromTaskPayload(payload) !== 'telegram'
  ) {
    return null;
  }

  const chatId = getCommunicationChannelFromTaskPayload(payload);

  if (!chatId) {
    return null;
  }

  const threadId = getCommunicationThreadIdFromTaskPayload(payload);
  const replyToMessageId = getCommunicationMessageIdFromTaskPayload(payload);

  return {
    chatId,
    ...(threadId ? { threadId } : {}),
    ...(replyToMessageId ? { replyToMessageId } : {}),
  };
}

const LINEAR_MCP_URL = 'https://mcp.linear.app/mcp';

async function resolveLinearClient() {
  const connection = await findLinearDeploymentMcpConnection();

  if (!connection) {
    return null;
  }

  const accessToken = await getValidAccessToken(connection.id, LINEAR_MCP_URL);

  if (!accessToken) {
    return null;
  }

  return createLinearClient(accessToken);
}

/**
 * Notifies Telegram chats and Linear sessions associated with a PR that the PR
 * has been merged. Links the merged PR to cloud jobs scoped to the merging
 * source control provider (GitHub, GitLab, Gitea, or Azure DevOps) using the
 * repository name and PR number, then posts the merge message to every Telegram
 * chat (via the best-effort poster) and Linear agent session (via a closing
 * response activity) it can resolve from those jobs.
 *
 * Fire-and-forget and best-effort, mirroring the Slack and Teams PR-merge
 * notifiers.
 */
export async function notifyTelegramAndLinearPrMerge({
  sourceControlProvider,
  installationId,
  repository,
  prNumber,
  prTitle,
  prUrl,
  mergedBy,
}: NotifyTelegramAndLinearPrMergeParams): Promise<void> {
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
          `[notifyTelegramAndLinearPrMerge] No GitHub installation found for installationId ${installationId}`,
        );
        return;
      }
    }

    // Link the merged PR to tasks for this source control provider. Scoping by
    // provider avoids cross-notifying when two providers share the same
    // owner/repo string and PR number in one deployment.
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

    // Telegram routing metadata lives on run payloads; Linear session
    // bindings live on the tasks rows.
    const [linkedRuns, linkedTasksWithLinearSessions] = await Promise.all([
      db.query.taskRuns.findMany({
        where: inArray(taskRuns.taskId, taskIds),
        columns: {
          payload: true,
        },
      }),
      db.query.tasks.findMany({
        where: and(
          inArray(tasks.id, taskIds),
          isNotNull(tasks.linearSessionId),
        ),
        columns: {
          linearSessionId: true,
        },
      }),
    ]);

    const telegramTargets = linkedRuns
      .map((run) => getTelegramPrMergeTarget(run.payload))
      .filter((target): target is TelegramPrMergeTarget => target !== null);

    const linearSessionIds = linkedTasksWithLinearSessions
      .map((task) => task.linearSessionId)
      .filter((sessionId): sessionId is string => Boolean(sessionId));

    if (telegramTargets.length === 0 && linearSessionIds.length === 0) {
      return;
    }

    const mergeNotification = buildPullRequestMergedNotificationText({
      prTitle,
      prUrl,
      mergedBy,
      formatLink: formatMarkdownLink,
      formatStatus: (status) => `**${status}**`,
    });

    if (telegramTargets.length > 0) {
      const notifiedConversations = new Set<string>();

      for (const target of telegramTargets) {
        const conversationKey = `${target.chatId}:${target.threadId ?? ''}`;

        if (notifiedConversations.has(conversationKey)) {
          continue;
        }

        // postTelegramMessageBestEffort is already best-effort: it catches
        // posting errors internally and returns null, so no try/catch is
        // needed here.
        const result = await postTelegramMessageBestEffort({
          chatId: target.chatId,
          ...(target.threadId ? { threadId: target.threadId } : {}),
          ...(target.replyToMessageId
            ? { replyToMessageId: target.replyToMessageId }
            : {}),
          text: mergeNotification.bodyText,
          textFormat: 'markdown',
        });

        notifiedConversations.add(conversationKey);

        if (result) {
          console.log(
            `[notifyTelegramAndLinearPrMerge] Sent notification to Telegram conversation ${conversationKey} for PR ${repository}#${prNumber}`,
          );
        }
      }
    }

    if (linearSessionIds.length > 0) {
      const linearClient = await resolveLinearClient();

      if (!linearClient) {
        console.warn(
          '[notifyTelegramAndLinearPrMerge] No active Linear connection, skipping Linear PR-merge notification',
        );
      } else {
        const notifiedSessions = new Set<string>();

        for (const sessionId of linearSessionIds) {
          if (notifiedSessions.has(sessionId)) {
            continue;
          }

          // emitResponse catches errors internally and returns a result
          // object, so no try/catch is needed here.
          const result = await linearClient.emitResponse(
            sessionId,
            mergeNotification.bodyText,
          );

          notifiedSessions.add(sessionId);

          if (result.success) {
            console.log(
              `[notifyTelegramAndLinearPrMerge] Sent notification to Linear session ${sessionId} for PR ${repository}#${prNumber}`,
            );
          } else {
            console.error(
              `[notifyTelegramAndLinearPrMerge] Failed to send Linear notification for session ${sessionId}: ${result.error ?? 'Unknown error'}`,
            );
          }
        }
      }
    }
  } catch (error) {
    console.error(
      `[notifyTelegramAndLinearPrMerge] Error notifying Telegram/Linear conversations for PR ${repository}#${prNumber}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
