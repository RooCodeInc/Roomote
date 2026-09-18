import {
  and,
  asc,
  db,
  eq,
  findActiveSlackInstallationForChannel,
  getBackgroundAgentSettings,
  isNull,
  sessions,
  taskPlatformIssueReports,
  upsertBackgroundAutomationSlackThread,
  users,
} from '@roomote/db/server';
import { Env } from '@roomote/env';
import { SlackNotifier } from '@roomote/slack';
import {
  platformIssueReportSchema,
  type CommunicationProvider,
  type CreatePlatformIssueReportInput,
} from '@roomote/types';

import { createDiscordCommunicationProviderFromRuntimeCredentials } from './discord-communication';
import {
  listConnectedCommunicationProviders,
  sendAutomationEmailReport,
} from '../automations/destination';
import {
  hasUserDirectMessageIdentity,
  sendUserDirectMessage,
} from './user-direct-message';
import {
  appendManagerSlackFooter,
  buildAutomationSettingsMessage,
  degradeSlackMrkdwnToMarkdown,
  PLATFORM_ISSUE_ALERTS_SETTINGS_HASH,
} from './manager-slack';

export type PlatformIssueSource =
  | { taskId: string; sessionId?: never }
  | { sessionId: string; taskId?: never };

function getAppUrl(): string {
  return process.env.R_APP_URL ?? Env.R_APP_URL;
}

function describePlatformIssueSource(source: PlatformIssueSource): string {
  return source.taskId
    ? `task ${source.taskId}`
    : `session ${source.sessionId}`;
}

export function buildPlatformIssueSourceUrl(
  source: PlatformIssueSource,
  utmSource: CommunicationProvider | 'platform_issue_submission',
): string {
  if (source.taskId) {
    const url = new URL(`/task/${source.taskId}`, getAppUrl());
    url.searchParams.set('utm_source', utmSource);
    url.searchParams.set(
      'utm_medium',
      utmSource === 'platform_issue_submission' ? 'web' : 'integration',
    );
    if (utmSource !== 'platform_issue_submission') {
      url.searchParams.set('utm_campaign', 'platform_issue_alert');
    }
    return url.toString();
  }

  const url = new URL(`/sessions/${source.sessionId}`, getAppUrl());
  url.searchParams.set('utm_source', utmSource);
  url.searchParams.set(
    'utm_medium',
    utmSource === 'platform_issue_submission' ? 'web' : 'integration',
  );
  if (utmSource !== 'platform_issue_submission') {
    url.searchParams.set('utm_campaign', 'platform_issue_alert');
  }
  return url.toString();
}

function buildPlatformIssueSubmissionUrl(reportId: string): string {
  return new URL(`/platform-issues/${reportId}/submit`, getAppUrl()).toString();
}

function buildPlatformIssueAlertText(params: {
  reportId: string;
  source: PlatformIssueSource;
  report: { title: string; summary: string };
  utmSource: CommunicationProvider;
}): string {
  const sourceUrl = buildPlatformIssueSourceUrl(
    params.source,
    params.utmSource,
  );
  const submissionUrl = buildPlatformIssueSubmissionUrl(params.reportId);
  const sourceLabel = params.source.taskId ? 'task' : 'session';

  return appendManagerSlackFooter(
    `Platform issue reported: *${params.report.title}*\n` +
      `> ${params.report.summary}\n` +
      `Roomote has not received this report. <${submissionUrl}|Review and send it to Roomote> if you'd like help.\n` +
      `<${sourceUrl}|View ${sourceLabel}>`,
  );
}

function buildPlatformIssueSlackAlertMessage(params: {
  reportId: string;
  source: PlatformIssueSource;
  report: { title: string; summary: string };
}) {
  const sourceUrl = buildPlatformIssueSourceUrl(params.source, 'slack');

  return buildAutomationSettingsMessage(
    `Platform issue reported: *${params.report.title}*\n` +
      `> ${params.report.summary}\n` +
      `Roomote has not received this report. Review what will be shared, then send it to Roomote if you'd like help.`,
    PLATFORM_ISSUE_ALERTS_SETTINGS_HASH,
    {
      taskUrl: sourceUrl,
      slackIcon: 'triangle-alert',
      additionalActions: [
        {
          type: 'button',
          action_id: 'platform_issue_review_and_send',
          text: {
            type: 'plain_text',
            text: 'Send to Roomote',
            emoji: false,
          },
          url: buildPlatformIssueSubmissionUrl(params.reportId),
        },
      ],
    },
  );
}

// slackPostedAt predates Discord delivery and now means posted to any alert destination.
async function markPlatformIssueReportPosted(reportRowId: string) {
  await db
    .update(taskPlatformIssueReports)
    .set({ slackPostedAt: new Date() })
    .where(
      and(
        eq(taskPlatformIssueReports.id, reportRowId),
        isNull(taskPlatformIssueReports.slackPostedAt),
      ),
    );
}

async function notifyDeploymentAdminsOfPlatformIssue(params: {
  reportId: string;
  source: PlatformIssueSource;
  report: { title: string; summary: string };
}): Promise<{ complete: boolean; delivered: boolean }> {
  const [admins, providers] = await Promise.all([
    db.query.users.findMany({
      where: and(eq(users.role, 'admin'), isNull(users.deletedAt)),
      columns: { id: true },
      orderBy: asc(users.createdAt),
    }),
    listConnectedCommunicationProviders(),
  ]);
  let delivered = false;
  let eligibleAdmins = 0;
  let deliveredAdmins = 0;

  for (const admin of admins) {
    const linkedProviders: CommunicationProvider[] = [];
    for (const provider of providers) {
      if (await hasUserDirectMessageIdentity(provider, admin.id)) {
        linkedProviders.push(provider);
      }
    }
    if (linkedProviders.length === 0) continue;

    eligibleAdmins += 1;
    for (const provider of linkedProviders) {
      const alertText = buildPlatformIssueAlertText({
        reportId: params.reportId,
        source: params.source,
        report: params.report,
        utmSource: provider,
      });
      const slackMessage =
        provider === 'slack'
          ? buildPlatformIssueSlackAlertMessage(params)
          : null;
      const sent = await sendUserDirectMessage({
        provider,
        userId: admin.id,
        text: slackMessage?.text ?? degradeSlackMrkdwnToMarkdown(alertText),
        slackBlocks: slackMessage?.blocks,
        logContext: 'platformIssueReporting',
      });

      if (sent) {
        delivered = true;
        deliveredAdmins += 1;
        break;
      }
    }
  }

  return {
    complete: eligibleAdmins > 0 && deliveredAdmins === eligibleAdmins,
    delivered,
  };
}

export async function notifyPlatformIssueReport(params: {
  reportRowId: string;
  source: PlatformIssueSource;
  report: { title: string; summary: string };
  slackPostedAt: Date | null;
}): Promise<void> {
  if (params.slackPostedAt) return;

  const settings = await getBackgroundAgentSettings();
  if (!settings.platformIssueAlertsEnabled) return;

  const sourceDescription = describePlatformIssueSource(params.source);
  if (
    settings.platformIssueEmailUserId &&
    settings.platformIssueEmailIdentityId
  ) {
    try {
      await sendAutomationEmailReport(
        {
          provider: 'email',
          channelId: settings.platformIssueEmailUserId,
          userId: settings.platformIssueEmailUserId,
          identityId: settings.platformIssueEmailIdentityId,
          source: 'automation_target',
        },
        {
          subject: `Roomote platform issue: ${params.report.title}`,
          conversationKey: `builtin-automation:platform_issue_alerts:${params.reportRowId}`,
          text: degradeSlackMrkdwnToMarkdown(
            buildPlatformIssueAlertText({
              reportId: params.reportRowId,
              source: params.source,
              report: params.report,
              utmSource: 'agentmail',
            }),
          ),
          idempotencyKey: `platform-issue:${params.reportRowId}`,
        },
      );
      await markPlatformIssueReportPosted(params.reportRowId);
    } catch (error) {
      console.warn(
        `[platformIssueReporting] Failed explicit Email destination for ${sourceDescription}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return;
  }
  const discordChannelId =
    settings.platformIssueDiscordChannelId ??
    (!settings.platformIssueSlackChannelId && !settings.managerSlackChannelId
      ? settings.managerDiscordChannelId
      : null);

  if (discordChannelId) {
    const discord =
      await createDiscordCommunicationProviderFromRuntimeCredentials();
    if (!discord) {
      console.warn(
        `[platformIssueReporting] No Discord credentials, skipping platform issue Discord alert for ${sourceDescription}`,
      );
      return;
    }

    await discord.postMessage({
      channelId: discordChannelId,
      text: degradeSlackMrkdwnToMarkdown(
        buildPlatformIssueAlertText({
          reportId: params.reportRowId,
          source: params.source,
          report: params.report,
          utmSource: 'discord',
        }),
      ),
      textFormat: 'markdown',
    });
    await markPlatformIssueReportPosted(params.reportRowId);
    return;
  }

  const channelId =
    settings.platformIssueSlackChannelId ?? settings.managerSlackChannelId;
  if (!channelId) {
    const delivery = await notifyDeploymentAdminsOfPlatformIssue({
      reportId: params.reportRowId,
      source: params.source,
      report: params.report,
    });
    if (delivery.complete) {
      await markPlatformIssueReportPosted(params.reportRowId);
    } else {
      console.warn(
        delivery.delivered
          ? `[platformIssueReporting] Some linked admins did not receive the platform issue alert for ${sourceDescription}; leaving it pending for retry`
          : `[platformIssueReporting] No configured channel or linked admin DM destination for platform issue alert on ${sourceDescription}`,
      );
    }
    return;
  }

  const slackInstallation =
    await findActiveSlackInstallationForChannel(channelId);
  if (!slackInstallation?.botAccessToken) {
    console.warn(
      `[platformIssueReporting] No unambiguous active Slack installation for channel ${channelId}, skipping platform issue Slack alert for ${sourceDescription}`,
    );
    return;
  }

  const slack = new SlackNotifier(slackInstallation.botAccessToken);
  const message = buildPlatformIssueSlackAlertMessage({
    reportId: params.reportRowId,
    source: params.source,
    report: params.report,
  });
  const messageTs = await slack.postMessage({
    channel: channelId,
    ...message,
    unfurl_links: false,
    unfurl_media: false,
  });
  if (!messageTs) {
    console.warn(
      `[platformIssueReporting] Failed to post platform issue Slack alert for ${sourceDescription}`,
    );
    return;
  }

  try {
    await upsertBackgroundAutomationSlackThread(db, {
      surface: 'slack',
      automationKey: 'platform_issue_alerts',
      slackTeamId: slackInstallation.teamId,
      slackChannelId: channelId,
      threadTs: messageTs,
      summaryText: message.text,
      postedAt: new Date(),
      metadata: {
        ...(params.source.taskId
          ? { sourceTaskId: params.source.taskId }
          : { sourceSessionId: params.source.sessionId }),
        slackTeamId: slackInstallation.teamId,
      },
    });
  } catch (error) {
    console.warn(
      `[platformIssueReporting] Failed to track platform issue Slack alert thread for ${sourceDescription}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  await markPlatformIssueReportPosted(params.reportRowId);
}

export async function createFastSessionPlatformIssueReport(input: {
  fastConversationId: string;
  fastEventId: string;
  report: CreatePlatformIssueReportInput;
  userId: string;
}): Promise<{
  success: true;
  reportCreated: true;
  report: CreatePlatformIssueReportInput;
}> {
  const report = platformIssueReportSchema.parse(input.report);
  const session = await db.query.sessions.findFirst({
    where: eq(sessions.fastConversationId, input.fastConversationId),
    columns: { id: true, privacy: true, privateOwnerUserId: true },
  });
  if (!session) {
    throw new Error('This Fast conversation is not attached to a session.');
  }
  if (
    session.privacy === 'private' &&
    session.privateOwnerUserId !== input.userId
  ) {
    throw new Error(
      'This user cannot report issues from this private session.',
    );
  }

  const [inserted] = await db
    .insert(taskPlatformIssueReports)
    .values({
      sessionId: session.id,
      fastConversationId: input.fastConversationId,
      fastEventId: input.fastEventId,
      reportedByUserId: input.userId,
      report,
    })
    .onConflictDoNothing({
      target: [
        taskPlatformIssueReports.fastConversationId,
        taskPlatformIssueReports.fastEventId,
      ],
    })
    .returning({
      id: taskPlatformIssueReports.id,
      sessionId: taskPlatformIssueReports.sessionId,
      report: taskPlatformIssueReports.report,
      slackPostedAt: taskPlatformIssueReports.slackPostedAt,
    });
  const reportRow =
    inserted ??
    (await db.query.taskPlatformIssueReports.findFirst({
      where: and(
        eq(
          taskPlatformIssueReports.fastConversationId,
          input.fastConversationId,
        ),
        eq(taskPlatformIssueReports.fastEventId, input.fastEventId),
      ),
      columns: {
        id: true,
        sessionId: true,
        report: true,
        slackPostedAt: true,
      },
    }));

  if (!reportRow?.sessionId) {
    throw new Error('Failed to persist the session platform issue report.');
  }

  await notifyPlatformIssueReport({
    reportRowId: reportRow.id,
    source: { sessionId: reportRow.sessionId },
    report: reportRow.report,
    slackPostedAt: reportRow.slackPostedAt,
  }).catch((error) => {
    console.warn(
      `[platformIssueReporting] Failed to deliver session platform issue alert: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });

  return { success: true, reportCreated: true, report };
}
