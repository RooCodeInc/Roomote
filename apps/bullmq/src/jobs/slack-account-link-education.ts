import { Job } from 'bullmq';

import {
  and,
  cloudJobs,
  db,
  eq,
  slackInstallations,
  slackUserMappings,
} from '@roomote/db/server';
import {
  type SlackAccountLinkEducationRequest,
  recordSlackConversationMessageBestEffort,
  slackAccountLinkEducationRequestSchema,
} from '@roomote/sdk/server';
import { SlackNotifier } from '@roomote/slack';

export const SLACK_ACCOUNT_LINK_EDUCATION_TEXT =
  "Just FYI: I can code, but I can also answer questions about your code. Just DM me or @-mention me and I'll get right on it (I can even access stuff in other apps, like Linear or Notion, if you give me a link).";

type SlackAccountLinkEducationJob = Job<
  SlackAccountLinkEducationRequest,
  void,
  string
>;

export const slackAccountLinkEducationJob = async (
  job: SlackAccountLinkEducationJob,
): Promise<void> => {
  const parsed = slackAccountLinkEducationRequestSchema.safeParse(job.data);

  if (!parsed.success) {
    throw new Error(
      `[SlackAccountLinkEducation] Invalid job data: ${parsed.error.message}`,
    );
  }

  const data = parsed.data;

  const slackInstallation = await db.query.slackInstallations.findFirst({
    where: and(
      eq(slackInstallations.teamId, data.slackTeamId),
      eq(slackInstallations.isActive, true),
    ),
    columns: { botAccessToken: true },
  });

  if (!slackInstallation) {
    console.warn(
      `[SlackAccountLinkEducation] No active Slack installation for team ${data.slackTeamId}, skipping`,
    );
    return;
  }

  const userMapping = await db.query.slackUserMappings.findFirst({
    where: and(
      eq(slackUserMappings.slackUserId, data.slackUserId),
      eq(slackUserMappings.slackTeamId, data.slackTeamId),
    ),
    columns: {
      userId: true,
      updatedAt: true,
    },
  });

  if (!userMapping) {
    console.warn(
      `[SlackAccountLinkEducation] Slack user ${data.slackUserId} is no longer linked in ${data.slackTeamId}, skipping`,
    );
    return;
  }

  if (userMapping.userId !== data.userId) {
    console.log(
      `[SlackAccountLinkEducation] Slack user ${data.slackUserId} was relinked before delivery, skipping`,
    );
    return;
  }

  if (
    data.mappingLinkedAt &&
    userMapping.updatedAt.getTime() !== data.mappingLinkedAt.getTime()
  ) {
    console.log(
      `[SlackAccountLinkEducation] Slack user ${data.slackUserId} mapping timestamp changed before delivery, skipping stale job`,
    );
    return;
  }

  const hasQuestionTask = await db.query.cloudJobs.findFirst({
    where: and(
      eq(cloudJobs.userId, data.userId),
      eq(cloudJobs.requestedWorkKind, 'question'),
    ),
    columns: { id: true },
  });

  if (hasQuestionTask) {
    console.log(
      `[SlackAccountLinkEducation] User ${data.userId} already created a question task, skipping education DM`,
    );
    return;
  }

  const slack = new SlackNotifier(slackInstallation.botAccessToken);
  const dmChannelId = await slack.openConversation(data.slackUserId);

  if (!dmChannelId) {
    throw new Error(
      `[SlackAccountLinkEducation] Failed to open a DM with Slack user ${data.slackUserId}`,
    );
  }

  const messageTs = await slack.postMessage({
    channel: dmChannelId,
    text: SLACK_ACCOUNT_LINK_EDUCATION_TEXT,
  });

  if (!messageTs) {
    throw new Error(
      `[SlackAccountLinkEducation] Failed to send the education DM to Slack user ${data.slackUserId}`,
    );
  }

  await recordSlackConversationMessageBestEffort({
    logContext: 'slackAccountLinkEducation',
    subjectUserId: data.userId,
    slackTeamId: data.slackTeamId,
    subjectSlackUserId: data.slackUserId,
    slackChannelId: dmChannelId,
    conversationKind: 'dm',
    messageTs,
    direction: 'outbound',
    authorKind: 'roomote',
    source: 'account_link_education',
    text: SLACK_ACCOUNT_LINK_EDUCATION_TEXT,
  });

  console.log(
    `[SlackAccountLinkEducation] Sent education DM to ${data.slackUserId} in team ${data.slackTeamId}`,
  );
};
