import {
  db,
  slackInstallations,
  githubInstallations,
  taskPullRequests,
  taskRuns,
  tasks,
  eq,
  and,
  inArray,
  isNull,
  or,
  like,
} from '@roomote/db/server';
import {
  buildPullRequestStatusNotificationText,
  formatMarkdownLink,
} from '@roomote/communication/chat-messages';
import { createLinearClient } from '@roomote/linear';
import {
  findLinearDeploymentMcpConnection,
  getCommunicationProviderAdapter,
  getValidAccessToken,
} from '@roomote/sdk/server';
import {
  postSlackThreadMessageWithStickyFooter,
  resolveSlackReactionNames,
  SlackNotifier,
} from '@roomote/slack';
import {
  type SourceControlProvider,
  getCommunicationChannelFromTaskPayload,
  getCommunicationMessageIdFromTaskPayload,
  getCommunicationProviderFromTaskPayload,
  getCommunicationServiceUrlFromTaskPayload,
  getCommunicationThreadIdFromTaskPayload,
  getDiscordReactionTargetFromTaskPayload,
} from '@roomote/types';

/** Fixed Slack reaction for closed (not merged) PRs on the originating message. */
export const SLACK_PR_CLOSED_REACTION_EMOJI = '-1';

const LINEAR_MCP_URL = 'https://mcp.linear.app/mcp';

/**
 * Discord renders backslash escapes literally inside masked-link labels, so
 * instead of escaping we drop the characters that let untrusted title text
 * break out of the label (`[`, `]`, `\`) and split the scheme of any embedded
 * URL with a zero-width space so Discord does not auto-link it.
 */
function sanitizeDiscordLinkLabel(text: string): string {
  return text
    .replace(/[[\]\\]/g, '')
    .replace(/(https?):\/\//gi, '$1:\u200b//')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatDiscordPullRequestLink(label: string, url: string): string {
  const [, matchedTag, matchedTitle] =
    label.match(/^(\[[^\]]+\])\s+(.+)$/) ?? [];
  const tag = matchedTag ? `${matchedTag} ` : '';
  const title = sanitizeDiscordLinkLabel(matchedTitle ?? label);

  if (!title) {
    return `${tag}${url}`;
  }

  return `${tag}[${title}](${url})`;
}

interface NotifyPullRequestTerminalStatusParams {
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
  /**
   * Optional FK to the provider-scoped `repositories` row. When set, rows with
   * that `repositoryId` match, and legacy webhook-created `pr_review` links
   * that still have a NULL `repositoryId` can still match on repository name
   * (and host below). Exclusive ID-only lookup would drop those links.
   */
  repositoryId?: string | null;
  /**
   * Optional source-control instance host (for example `gitlab.example.com`).
   * Scopes the lookup so same-name hosts cannot notify each other's threads.
   * Rows with an explicit host must equal this value. NULL-host legacy rows
   * only match when their `prUrl` is on this same host.
   */
  host?: string | null;
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

type SlackTarget = {
  taskId: string;
  slackThreadTs: string;
  slackChannelId: string;
};

function getSlackTarget(taskId: string, payload: unknown): SlackTarget | null {
  if (getCommunicationProviderFromTaskPayload(payload) !== 'slack') {
    return null;
  }

  const slackChannelId = getCommunicationChannelFromTaskPayload(payload);
  const slackThreadTs = getCommunicationThreadIdFromTaskPayload(payload);

  if (!slackChannelId || !slackThreadTs) {
    return null;
  }

  return { taskId, slackChannelId, slackThreadTs };
}

type TeamsTarget = {
  channelId: string;
  serviceUrl: string;
  threadId?: string;
};

type TelegramTarget = {
  chatId: string;
  threadId?: string;
  replyToMessageId?: string;
};

type DiscordTarget = {
  channelId: string;
  threadId?: string;
  /** Valid Discord message+channel for platform reactions when present. */
  reaction?: {
    channelId: string;
    messageId: string;
  };
};

function getTeamsTarget(payload: unknown): TeamsTarget | null {
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

function getTelegramTarget(payload: unknown): TelegramTarget | null {
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

function getDiscordTarget(payload: unknown): DiscordTarget | null {
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
  const reactionTarget = getDiscordReactionTargetFromTaskPayload(payload);

  return {
    channelId,
    ...(threadId ? { threadId } : {}),
    ...(reactionTarget ? { reaction: reactionTarget } : {}),
  };
}

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

async function deliverSlackTerminalStatus({
  slackTargets,
  prTitle,
  prUrl,
  status,
  resolvedActorLogin,
  repository,
  prNumber,
}: {
  slackTargets: SlackTarget[];
  prTitle: string;
  prUrl: string;
  status: 'merged' | 'closed';
  resolvedActorLogin: string;
  repository: string;
  prNumber: number;
}): Promise<void> {
  if (slackTargets.length === 0) {
    return;
  }

  const slackInstallation = await db.query.slackInstallations.findFirst({
    where: eq(slackInstallations.isActive, true),
    columns: { botAccessToken: true },
  });

  if (!slackInstallation) {
    console.warn(
      '[notifyPullRequestTerminalStatus] No active Slack installation found',
    );
    return;
  }

  const notifiedThreads = new Set<string>();
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
  const terminalReaction =
    status === 'closed' ? SLACK_PR_CLOSED_REACTION_EMOJI : completionEmoji;

  for (const target of slackTargets) {
    const threadKey = `${target.slackChannelId}:${target.slackThreadTs}`;
    if (notifiedThreads.has(threadKey)) {
      continue;
    }

    try {
      await postSlackThreadMessageWithStickyFooter({
        slack: notifier,
        channel: target.slackChannelId,
        threadTs: target.slackThreadTs,
        taskId: target.taskId,
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

      // The status post completes user-visible delivery for this pass.
      // Record it before best-effort reaction cleanup so duplicate task/run
      // bindings cannot repost the same lifecycle message when cleanup fails.
      notifiedThreads.add(threadKey);

      const [terminalReactionResult, ackRemovalResult] =
        await Promise.allSettled([
          notifier.addReaction({
            channel: target.slackChannelId,
            timestamp: target.slackThreadTs,
            name: terminalReaction,
          }),
          notifier.removeReaction({
            channel: target.slackChannelId,
            timestamp: target.slackThreadTs,
            name: ackEmoji,
          }),
        ]);

      if (
        terminalReactionResult.status === 'rejected' ||
        !terminalReactionResult.value
      ) {
        console.warn(
          `[notifyPullRequestTerminalStatus] Failed to add ${status} reaction to Slack thread ${target.slackThreadTs}`,
        );
      }

      if (ackRemovalResult.status === 'rejected' || !ackRemovalResult.value) {
        console.warn(
          `[notifyPullRequestTerminalStatus] Failed to remove acknowledgement reaction from Slack thread ${target.slackThreadTs}`,
        );
      }

      console.log(
        `[notifyPullRequestTerminalStatus] Sent ${status} notification to Slack thread ${target.slackThreadTs} for PR ${repository}#${prNumber}`,
      );
    } catch (error) {
      console.error(
        `[notifyPullRequestTerminalStatus] Failed to send Slack notification for thread ${target.slackThreadTs}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  console.log(
    `[notifyPullRequestTerminalStatus] Notified ${notifiedThreads.size} unique Slack thread(s) for PR ${repository}#${prNumber}`,
  );
}

async function deliverTeamsTerminalStatus({
  teamsTargets,
  prTitle,
  prUrl,
  status,
  resolvedActorLogin,
  repository,
  prNumber,
}: {
  teamsTargets: TeamsTarget[];
  prTitle: string;
  prUrl: string;
  status: 'merged' | 'closed';
  resolvedActorLogin: string;
  repository: string;
  prNumber: number;
}): Promise<void> {
  if (teamsTargets.length === 0) {
    return;
  }

  const provider = await getCommunicationProviderAdapter('teams');

  if (!provider) {
    console.warn(
      '[notifyPullRequestTerminalStatus] Teams bot credentials are not configured, skipping Teams PR-status notification',
    );
    return;
  }

  const statusNotification = buildPullRequestStatusNotificationText({
    prTitle,
    prUrl,
    status,
    actorLogin: resolvedActorLogin,
    formatLink: formatMarkdownLink,
    formatStatus: (value) => `**${value}**`,
  });

  const notifiedConversations = new Set<string>();

  for (const target of teamsTargets) {
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
        text: statusNotification.bodyText,
        textFormat: 'markdown',
      });

      notifiedConversations.add(conversationKey);

      console.log(
        `[notifyPullRequestTerminalStatus] Sent ${status} notification to Teams conversation ${conversationKey} for PR ${repository}#${prNumber}`,
      );
    } catch (error) {
      console.error(
        `[notifyPullRequestTerminalStatus] Failed to send Teams notification for conversation ${conversationKey}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

async function deliverTelegramTerminalStatus({
  telegramTargets,
  prTitle,
  prUrl,
  status,
  resolvedActorLogin,
  repository,
  prNumber,
}: {
  telegramTargets: TelegramTarget[];
  prTitle: string;
  prUrl: string;
  status: 'merged' | 'closed';
  resolvedActorLogin: string;
  repository: string;
  prNumber: number;
}): Promise<void> {
  if (telegramTargets.length === 0) {
    return;
  }

  const provider = await getCommunicationProviderAdapter('telegram');

  if (!provider) {
    console.warn(
      '[notifyPullRequestTerminalStatus] Telegram bot credentials are not configured, skipping Telegram PR-status notification',
    );
    return;
  }

  const statusNotification = buildPullRequestStatusNotificationText({
    prTitle,
    prUrl,
    status,
    actorLogin: resolvedActorLogin,
    formatLink: formatMarkdownLink,
    formatStatus: (value) => `**${value}**`,
  });

  const notifiedConversations = new Set<string>();

  for (const target of telegramTargets) {
    const conversationKey = `${target.chatId}:${target.threadId ?? ''}`;

    if (notifiedConversations.has(conversationKey)) {
      continue;
    }

    try {
      await provider.postMessage({
        channelId: target.chatId,
        ...(target.threadId ? { threadId: target.threadId } : {}),
        ...(target.replyToMessageId
          ? { replyToMessageId: target.replyToMessageId }
          : {}),
        text: statusNotification.bodyText,
        textFormat: 'markdown',
      });

      notifiedConversations.add(conversationKey);

      console.log(
        `[notifyPullRequestTerminalStatus] Sent ${status} notification to Telegram conversation ${conversationKey} for PR ${repository}#${prNumber}`,
      );
    } catch (error) {
      console.error(
        `[notifyPullRequestTerminalStatus] Failed to send Telegram notification for conversation ${conversationKey}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

async function deliverDiscordTerminalStatus({
  discordTargets,
  prTitle,
  prUrl,
  status,
  resolvedActorLogin,
  repository,
  prNumber,
}: {
  discordTargets: DiscordTarget[];
  prTitle: string;
  prUrl: string;
  status: 'merged' | 'closed';
  resolvedActorLogin: string;
  repository: string;
  prNumber: number;
}): Promise<void> {
  if (discordTargets.length === 0) {
    return;
  }

  const provider = await getCommunicationProviderAdapter('discord');

  if (!provider) {
    console.warn(
      '[notifyPullRequestTerminalStatus] Discord bot credentials are not configured, skipping Discord PR-status notification',
    );
    return;
  }

  const statusNotification = buildPullRequestStatusNotificationText({
    prTitle,
    prUrl,
    status,
    actorLogin: resolvedActorLogin,
    formatLink: formatDiscordPullRequestLink,
    formatStatus: (value) => `**${value}**`,
  });
  // Match Slack terminal reactions: check on merge, thumbsdown on closed.
  const terminalReaction =
    status === 'closed' ? SLACK_PR_CLOSED_REACTION_EMOJI : 'white_check_mark';
  const ackEmoji = 'eyes';

  const notifiedConversations = new Set<string>();

  for (const target of discordTargets) {
    const conversationKey = `${target.channelId}:${target.threadId ?? ''}`;

    if (notifiedConversations.has(conversationKey)) {
      continue;
    }

    try {
      await provider.postMessage({
        channelId: target.channelId,
        ...(target.threadId ? { threadId: target.threadId } : {}),
        text: statusNotification.bodyText,
        textFormat: 'markdown',
      });

      const originReaction = target.reaction;
      if (originReaction && provider.addReaction) {
        // Add and remove independently. Eyes may already be gone after worker
        // onStart cleanup; a failed remove must not skip the terminal reaction.
        try {
          await provider.addReaction({
            channelId: originReaction.channelId,
            messageId: originReaction.messageId,
            name: terminalReaction,
          });
        } catch (error) {
          console.warn(
            `[notifyPullRequestTerminalStatus] Failed to add Discord terminal reaction for conversation ${conversationKey}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
        if (provider.removeReaction) {
          try {
            await provider.removeReaction({
              channelId: originReaction.channelId,
              messageId: originReaction.messageId,
              name: ackEmoji,
            });
          } catch {
            // Soft cleanup only.
          }
        }
      }

      notifiedConversations.add(conversationKey);

      console.log(
        `[notifyPullRequestTerminalStatus] Sent ${status} notification to Discord conversation ${conversationKey} for PR ${repository}#${prNumber}`,
      );
    } catch (error) {
      console.error(
        `[notifyPullRequestTerminalStatus] Failed to send Discord notification for conversation ${conversationKey}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

async function deliverLinearTerminalStatus({
  linearSessionIds,
  prTitle,
  prUrl,
  status,
  resolvedActorLogin,
  repository,
  prNumber,
}: {
  linearSessionIds: string[];
  prTitle: string;
  prUrl: string;
  status: 'merged' | 'closed';
  resolvedActorLogin: string;
  repository: string;
  prNumber: number;
}): Promise<void> {
  if (linearSessionIds.length === 0) {
    return;
  }

  const linearClient = await resolveLinearClient();

  if (!linearClient) {
    console.warn(
      '[notifyPullRequestTerminalStatus] No active Linear connection, skipping Linear PR-status notification',
    );
    return;
  }

  const statusNotification = buildPullRequestStatusNotificationText({
    prTitle,
    prUrl,
    status,
    actorLogin: resolvedActorLogin,
    formatLink: formatMarkdownLink,
    formatStatus: (value) => `**${value}**`,
  });

  const notifiedSessions = new Set<string>();

  for (const sessionId of linearSessionIds) {
    if (notifiedSessions.has(sessionId)) {
      continue;
    }

    try {
      const result = await linearClient.emitResponse(
        sessionId,
        statusNotification.bodyText,
      );

      notifiedSessions.add(sessionId);

      if (result.success) {
        console.log(
          `[notifyPullRequestTerminalStatus] Sent ${status} notification to Linear session ${sessionId} for PR ${repository}#${prNumber}`,
        );
      } else {
        console.error(
          `[notifyPullRequestTerminalStatus] Failed to send Linear notification for session ${sessionId}: ${result.error ?? 'Unknown error'}`,
        );
      }
    } catch (error) {
      console.error(
        `[notifyPullRequestTerminalStatus] Failed to send Linear notification for session ${sessionId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

/**
 * Notifies Slack, Teams, Telegram, Discord, and Linear conversations linked to a PR
 * when that PR becomes terminal (merged or closed).
 *
 * Resolves the GitHub installation gate (when provided) and provider-scoped
 * task-PR links once, then fans out delivery per surface: Slack sticky-footer
 * posts plus reactions, Teams/Telegram/Discord via the shared communication adapter,
 * and Linear session responses as their own path.
 *
 * Fire-and-forget and best-effort; individual surface failures do not throw.
 */
export async function notifyPullRequestTerminalStatus({
  sourceControlProvider,
  installationId,
  repository,
  repositoryId,
  host,
  prNumber,
  prTitle,
  prUrl,
  status = 'merged',
  actorLogin,
  mergedBy,
}: NotifyPullRequestTerminalStatusParams): Promise<void> {
  const resolvedActorLogin = actorLogin || mergedBy || 'someone';

  try {
    if (installationId !== undefined) {
      const githubInstallation = await db.query.githubInstallations.findFirst({
        where: eq(githubInstallations.installationId, installationId),
        columns: {
          id: true,
        },
      });

      if (!githubInstallation) {
        console.warn(
          `[notifyPullRequestTerminalStatus] No GitHub installation found for installationId ${installationId}`,
        );
        return;
      }
    }

    const repositoryScope = repositoryId
      ? or(
          eq(taskPullRequests.repositoryId, repositoryId),
          and(
            isNull(taskPullRequests.repositoryId),
            eq(taskPullRequests.repository, repository),
          ),
        )
      : eq(taskPullRequests.repository, repository);

    const hostScope = host
      ? or(
          eq(taskPullRequests.host, host),
          and(
            isNull(taskPullRequests.host),
            or(
              like(taskPullRequests.prUrl, `https://${host}/%`),
              like(taskPullRequests.prUrl, `http://${host}/%`),
            ),
          ),
        )
      : undefined;

    const prTaskLinks = await db.query.taskPullRequests.findMany({
      where: and(
        eq(taskPullRequests.sourceControlProvider, sourceControlProvider),
        eq(taskPullRequests.prNumber, prNumber),
        repositoryScope,
        ...(hostScope ? [hostScope] : []),
      ),
      columns: {
        taskId: true,
      },
    });

    const taskIds = Array.from(new Set(prTaskLinks.map((link) => link.taskId)));

    if (taskIds.length === 0) {
      console.log(
        `[notifyPullRequestTerminalStatus] No linked tasks found for PR ${repository}#${prNumber}`,
      );
      return;
    }

    const [linkedTasks, linkedRuns] = await Promise.all([
      db.query.tasks.findMany({
        where: inArray(tasks.id, taskIds),
        columns: {
          id: true,
          slackThreadTs: true,
          slackChannelId: true,
          linearSessionId: true,
        },
      }),
      db.query.taskRuns.findMany({
        where: inArray(taskRuns.taskId, taskIds),
        columns: {
          taskId: true,
          payload: true,
        },
      }),
    ]);

    const slackTargets: SlackTarget[] = [];
    const linearSessionIds: string[] = [];

    for (const task of linkedTasks) {
      if (task.slackThreadTs && task.slackChannelId) {
        slackTargets.push({
          taskId: task.id,
          slackThreadTs: task.slackThreadTs,
          slackChannelId: task.slackChannelId,
        });
      }

      if (task.linearSessionId) {
        linearSessionIds.push(task.linearSessionId);
      }
    }

    slackTargets.push(
      ...linkedRuns
        .map((run) => getSlackTarget(run.taskId, run.payload))
        .filter((target): target is SlackTarget => target !== null),
    );

    const teamsTargets = linkedRuns
      .map((run) => getTeamsTarget(run.payload))
      .filter((target): target is TeamsTarget => target !== null);

    const telegramTargets = linkedRuns
      .map((run) => getTelegramTarget(run.payload))
      .filter((target): target is TelegramTarget => target !== null);

    const discordTargets = linkedRuns
      .map((run) => getDiscordTarget(run.payload))
      .filter((target): target is DiscordTarget => target !== null);

    if (
      slackTargets.length === 0 &&
      teamsTargets.length === 0 &&
      telegramTargets.length === 0 &&
      discordTargets.length === 0 &&
      linearSessionIds.length === 0
    ) {
      console.log(
        `[notifyPullRequestTerminalStatus] No notification surfaces found for PR ${repository}#${prNumber}`,
      );
      return;
    }

    if (slackTargets.length > 0) {
      console.log(
        `[notifyPullRequestTerminalStatus] Found ${slackTargets.length} Slack thread binding(s) for PR ${repository}#${prNumber}`,
      );
    }

    await Promise.all([
      deliverSlackTerminalStatus({
        slackTargets,
        prTitle,
        prUrl,
        status,
        resolvedActorLogin,
        repository,
        prNumber,
      }),
      deliverTeamsTerminalStatus({
        teamsTargets,
        prTitle,
        prUrl,
        status,
        resolvedActorLogin,
        repository,
        prNumber,
      }),
      deliverTelegramTerminalStatus({
        telegramTargets,
        prTitle,
        prUrl,
        status,
        resolvedActorLogin,
        repository,
        prNumber,
      }),
      deliverDiscordTerminalStatus({
        discordTargets,
        prTitle,
        prUrl,
        status,
        resolvedActorLogin,
        repository,
        prNumber,
      }),
      deliverLinearTerminalStatus({
        linearSessionIds,
        prTitle,
        prUrl,
        status,
        resolvedActorLogin,
        repository,
        prNumber,
      }),
    ]);
  } catch (error) {
    console.error(
      `[notifyPullRequestTerminalStatus] Error notifying surfaces for PR ${repository}#${prNumber}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Fire-and-forget wrapper for source-control webhook handlers.
 */
export function scheduleNotifyPullRequestTerminalStatus(
  params: NotifyPullRequestTerminalStatusParams,
  logContext?: string,
): void {
  const label = logContext ?? `PR ${params.repository}#${params.prNumber}`;

  void notifyPullRequestTerminalStatus(params).catch((error) => {
    console.error(
      `[notifyPullRequestTerminalStatus] Failed to notify surfaces for ${label}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });
}
