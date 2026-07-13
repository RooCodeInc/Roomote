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
import { buildPullRequestStatusNotificationText } from '@roomote/communication/chat-messages';
import {
  postSlackThreadMessageWithStickyFooter,
  resolveSlackReactionNames,
  SlackNotifier,
} from '@roomote/slack';
import { type SourceControlProvider } from '@roomote/types';

/** Fixed Slack reaction for closed (not merged) PRs on the originating message. */
export const SLACK_PR_CLOSED_REACTION_EMOJI = 'heavy_multiplication_x';

interface NotifySlackPrMergeParams {
  /**
   * Source control provider that owns the terminal PR/MR. Used to scope the
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
  /**
   * Terminal PR status. Defaults to `merged` so existing merge-only callers
   * keep their previous notification and checkmark reaction behavior.
   */
  status?: 'merged' | 'closed';
  /**
   * Actor who merged or closed the PR (provider login).
   */
  actorLogin?: string;
  /**
   * @deprecated Prefer `actorLogin`. Kept for merge-only call sites that have
   * not been updated yet.
   */
  mergedBy?: string;
}

/**
 * Notifies Slack threads associated with a PR that the PR has been merged or
 * closed. Queries for tasks that reference the PR and have a Slack thread,
 * filtering by GitHub installation (when provided) to ensure only the tracked
 * deployment receives notifications.
 *
 * Posts the status message as the sticky "Working on..." footer carrier for
 * the thread, matching agent and review out-of-band placement. On merge, adds
 * the configured completion emoji to the originating message; on close, adds
 * :heavy_multiplication_x:. Both remove the acknowledgement emoji.
 */
export async function notifySlackPrMerge({
  sourceControlProvider,
  installationId,
  repository,
  prNumber,
  prTitle,
  prUrl,
  status = 'merged',
  actorLogin,
  mergedBy,
}: NotifySlackPrMergeParams): Promise<void> {
  const resolvedActorLogin = actorLogin || mergedBy || 'someone';

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
        id: true,
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
      const { id: taskId, slackThreadTs, slackChannelId } = task;

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
        const statusNotification = buildPullRequestStatusNotificationText({
          prTitle,
          prUrl,
          status,
          actorLogin: resolvedActorLogin,
          formatLink: (label, url) => `<${url}|${label}>`,
          formatStatus: (value) => `*${value}*`,
        });

        await postSlackThreadMessageWithStickyFooter({
          slack: notifier,
          channel,
          threadTs: slackThreadTs,
          taskId,
          text: statusNotification.text,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: statusNotification.bodyText,
              },
            },
          ],
          utmCampaign: 'slack.pr_status',
          // Keep sticky placement on the latest message, but never claim the
          // bot is still working once the PR is terminal.
          footerStyle: 'reply-only',
        });

        const terminalReaction =
          status === 'closed'
            ? SLACK_PR_CLOSED_REACTION_EMOJI
            : completionEmoji;

        // Add a terminal reaction to the originating (parent) message in the
        // thread and remove the acknowledgement reaction.
        await Promise.all([
          notifier.addReaction({
            channel,
            timestamp: slackThreadTs,
            name: terminalReaction,
          }),
          notifier.removeReaction({
            channel,
            timestamp: slackThreadTs,
            name: ackEmoji,
          }),
        ]);

        notifiedThreads.add(slackThreadTs);

        console.log(
          `[notifySlackPrMerge] Sent ${status} notification to Slack thread ${slackThreadTs} for PR ${repository}#${prNumber}`,
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
