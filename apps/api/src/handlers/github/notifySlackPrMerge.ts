import {
  db,
  slackInstallations,
  githubInstallations,
  taskPullRequests,
  tasks,
  eq,
  and,
  inArray,
  isNotNull,
} from '@roomote/db/server';
import { buildPullRequestMergedNotificationText } from '@roomote/communication/chat-messages';
import { resolveSlackReactionNames, SlackNotifier } from '@roomote/slack';
import { type SourceControlProvider } from '@roomote/types';

interface NotifySlackPrMergeParams {
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

/**
 * Notifies Slack threads associated with a PR that the PR has been merged.
 * Queries for cloud jobs that reference the PR and have a Slack thread,
 * filtering by GitHub installation to ensure only the tracked deployment
 * receives notifications.
 */
export async function notifySlackPrMerge({
  sourceControlProvider,
  installationId,
  repository,
  prNumber,
  prTitle,
  prUrl,
  mergedBy,
}: NotifySlackPrMergeParams): Promise<void> {
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
          `[notifySlackPrMerge] No GitHub installation found for installationId ${installationId}`,
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
      console.log(
        `[notifySlackPrMerge] No linked tasks found for PR ${repository}#${prNumber}`,
      );
      return;
    }

    // Find linked tasks that have Slack thread bindings.
    const tasksWithSlackThreads = await db.query.tasks.findMany({
      where: and(inArray(tasks.id, taskIds), isNotNull(tasks.slackThreadTs)),
      columns: {
        slackThreadTs: true,
        slackChannelId: true,
      },
    });

    if (tasksWithSlackThreads.length === 0) {
      console.log(
        `[notifySlackPrMerge] No Slack threads found for PR ${repository}#${prNumber}`,
      );
      return;
    }

    console.log(
      `[notifySlackPrMerge] Found ${tasksWithSlackThreads.length} Slack thread(s) for PR ${repository}#${prNumber}`,
    );

    const slackInstallation = await db.query.slackInstallations.findFirst({
      where: eq(slackInstallations.isActive, true),
      columns: { botAccessToken: true },
    });

    if (!slackInstallation) {
      console.warn('[notifySlackPrMerge] No active Slack installation found');
      return;
    }

    // Send notification to each unique thread
    const notifiedThreads = new Set<string>();

    for (const task of tasksWithSlackThreads) {
      const { slackThreadTs, slackChannelId } = task;

      if (!slackThreadTs) {
        continue;
      }

      // Skip if we already notified this thread
      if (notifiedThreads.has(slackThreadTs)) {
        continue;
      }

      try {
        const channel = slackChannelId;

        if (!channel) {
          console.warn(
            `[notifySlackPrMerge] No Slack channel bound for thread ${slackThreadTs}`,
          );

          continue;
        }

        const notifier = new SlackNotifier(slackInstallation.botAccessToken);
        const { ackEmoji, completionEmoji } = await resolveSlackReactionNames();
        const mergeNotification = buildPullRequestMergedNotificationText({
          prTitle,
          prUrl,
          mergedBy,
          formatLink: (label, url) => `<${url}|${label}>`,
          formatStatus: (status) => `*${status}*`,
        });

        await notifier.postMessage({
          channel,
          thread_ts: slackThreadTs,
          text: mergeNotification.text,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: mergeNotification.bodyText,
              },
            },
          ],
        });

        // Add a ✅ reaction to the originating (parent) message in the thread
        // and remove the 👀 acknowledgement reaction.
        await Promise.all([
          notifier.addReaction({
            channel,
            timestamp: slackThreadTs,
            name: completionEmoji,
          }),
          notifier.removeReaction({
            channel,
            timestamp: slackThreadTs,
            name: ackEmoji,
          }),
        ]);

        notifiedThreads.add(slackThreadTs);

        console.log(
          `[notifySlackPrMerge] Sent notification to Slack thread ${slackThreadTs} for PR ${repository}#${prNumber}`,
        );
      } catch (error) {
        console.error(
          `[notifySlackPrMerge] Failed to send Slack notification for thread ${slackThreadTs}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    console.log(
      `[notifySlackPrMerge] Notified ${notifiedThreads.size} unique Slack thread(s) for PR ${repository}#${prNumber}`,
    );
  } catch (error) {
    console.error(
      `[notifySlackPrMerge] Error notifying Slack threads for PR ${repository}#${prNumber}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
