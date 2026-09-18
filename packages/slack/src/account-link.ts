import { randomUUID } from 'node:crypto';

import { PRODUCT_NAME } from '@roomote/types';
import { Env } from '@roomote/env';
import {
  buildAccountLinkConnectCopy,
  buildAccountLinkThreadReplyText as buildSharedAccountLinkThreadReplyText,
} from '@roomote/communication/chat-messages';
import {
  type SlackInstallation,
  db,
  slackAuthTokens,
} from '@roomote/db/server';

import type {
  SlackEvent,
  SlackInteractivePayload,
  SlackMessage,
} from './types';
import { SlackNotifier } from './slack-notifier';

const SLACK_AUTH_NO_RESUME_SENTINEL = '__roomote:no-resume__';

export function shouldResumeSlackAuthThread(originalText: string): boolean {
  return originalText !== SLACK_AUTH_NO_RESUME_SENTINEL;
}

export interface SlackAccountLinkPromptResult {
  dmPromptSent: boolean;
}

export function buildSlackAccountLinkConnectMessage(
  authToken: string,
): SlackMessage {
  const copy = buildAccountLinkConnectCopy({
    providerName: 'Slack',
    productName: PRODUCT_NAME,
  });

  return {
    text: `👋 ${copy.fallbackText}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: copy.introText,
        },
      },
      { type: 'divider' },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${copy.requirementText}*\n\nThis links your identity so I can:\n${copy.identityBenefits
            .map((benefit) => `• ${benefit}`)
            .join('\n')}`,
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            action_id: 'connect_account',
            text: {
              type: 'plain_text',
              text: copy.buttonText,
              emoji: true,
            },
            url: `${Env.SLACK_AUTH_URI}?state=${authToken}`,
            style: 'primary',
          },
        ],
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: copy.contextText,
          },
        ],
      },
    ],
  };
}

function isSlackDirectMessageChannel(
  channel: string,
  channelType?: string,
): boolean {
  return channelType === 'im' || channel.startsWith('D');
}

export function buildSlackAccountLinkThreadReplyText({
  slackUserId,
  dmPromptSent,
}: {
  slackUserId: string;
  dmPromptSent: boolean;
}): string {
  return buildSharedAccountLinkThreadReplyText({
    userMention: `<@${slackUserId}>`,
    dmPromptSent,
  });
}

export async function promptSlackAccountLink({
  slackUserId,
  channel,
  threadTs,
  messageTs,
  originalText,
  slackInstallation,
  slack,
  resumeOriginalThread = true,
}: {
  slackUserId: string;
  channel: string;
  threadTs: string;
  messageTs?: string;
  originalText: string;
  slackInstallation: SlackInstallation;
  slack: SlackNotifier;
  resumeOriginalThread?: boolean;
}): Promise<SlackAccountLinkPromptResult> {
  const authToken = randomUUID();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15m

  const [slackAuthToken] = await db
    .insert(slackAuthTokens)
    .values({
      token: authToken,
      slackUserId,
      slackTeamId: slackInstallation.teamId,
      channel,
      threadTs,
      messageTs,
      originalText: resumeOriginalThread
        ? originalText
        : SLACK_AUTH_NO_RESUME_SENTINEL,
      expiresAt,
    })
    .returning();

  if (!slackAuthToken) {
    throw new Error('Unable to create Slack auth token.');
  }

  const dmChannelId = await slack.openConversation(slackUserId);
  const connectMessage = buildSlackAccountLinkConnectMessage(authToken);

  if (dmChannelId) {
    try {
      const dmTs = await slack.postMessage({
        ...connectMessage,
        channel: dmChannelId,
      });

      if (!dmTs) {
        console.error(
          `[showConnectAccount] Failed to send connect prompt DM to Slack user ${slackUserId}: Slack returned no message timestamp`,
        );
      }

      return { dmPromptSent: Boolean(dmTs) };
    } catch (error) {
      console.error(
        `[showConnectAccount] Failed to send connect prompt DM to Slack user ${slackUserId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { dmPromptSent: false };
    }
  }

  console.warn(
    `[showConnectAccount] Could not open DM channel for Slack user ${slackUserId}; skipping connect prompt delivery`,
  );

  return { dmPromptSent: false };
}

export async function postSlackAccountLinkThreadReply({
  slack,
  channel,
  threadTs,
  slackUserId,
  dmPromptSent,
  channelType,
}: {
  slack: SlackNotifier;
  channel: string;
  threadTs: string;
  slackUserId: string;
  dmPromptSent: boolean;
  channelType?: string;
}): Promise<void> {
  if (isSlackDirectMessageChannel(channel, channelType)) {
    return;
  }

  await slack.postMessage({
    text: buildSlackAccountLinkThreadReplyText({
      slackUserId,
      dmPromptSent,
    }),
    channel,
    thread_ts: threadTs,
  });
}

export async function showConnectAccount(
  event: SlackEvent,
  slackInstallation: SlackInstallation,
  slack: SlackNotifier,
) {
  const threadId = event.thread_ts || event.ts;
  const promptResult = await promptSlackAccountLink({
    slackUserId: event.user,
    channel: event.channel,
    threadTs: threadId,
    messageTs: event.ts,
    originalText: event.text,
    slackInstallation,
    slack,
  });

  await postSlackAccountLinkThreadReply({
    slack,
    channel: event.channel,
    threadTs: threadId,
    slackUserId: event.user,
    dmPromptSent: promptResult.dmPromptSent,
    channelType: event.channel_type,
  });
}

export async function handleConnectAccount(payload: SlackInteractivePayload) {
  // Keep the connect prompt visible after click so users can retry if auth
  // fails or if they abandon the browser flow before completion.
  void payload;
}
