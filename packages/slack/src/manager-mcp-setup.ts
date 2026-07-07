import { randomUUID } from 'node:crypto';

import { Env } from '@roomote/env';
import { getRedis } from '@roomote/redis';
import type { SlackBlock } from '@roomote/types';
import {
  and,
  db,
  eq,
  getBackgroundAgentSettingsForDeployment,
  mcpSetupManagerNotifications,
  slackInstallations,
  slackUserMappings,
  users,
  type ManagerMcpSetupNotificationReason,
} from '@roomote/db/server';
import type { SlackMcpSetupRequirement } from '@roomote/cloud-agents/server';

import type { SlackInteractivePayload } from './types';
import { SlackNotifier } from './slack-notifier';
import { postSlackInteractiveResponse } from './interactive-response';

export const MANAGER_MCP_SETUP_CONFIGURE_ACTION_ID =
  'manager_mcp_setup_configure';
export const MANAGER_MCP_SETUP_NO_THANKS_ACTION_ID =
  'manager_mcp_setup_no_thanks';

const MANAGER_MCP_SETUP_NOTIFICATION_LOCK_TTL_SECONDS = 60;

function isManagerMcpSetupReason(
  reason: SlackMcpSetupRequirement['reason'],
): reason is ManagerMcpSetupNotificationReason {
  return (
    reason === 'deployment_disabled' || reason === 'deployment_auth_required'
  );
}

function buildManagerMcpSetupConfigureUrl(serviceId: string): string {
  const url = new URL('/settings/integrations', Env.ROOMOTE_APP_URL);
  url.searchParams.set('service', serviceId);
  url.searchParams.set('source', 'slack-manager-integration-setup');
  return url.toString();
}

function buildManagerMcpSetupMessageText(params: {
  userLabel: string;
  serviceName: string;
}): string {
  return `${params.userLabel} tried to use the ${params.serviceName} integration, but it's not set up yet. Want to set it up now?`;
}

export function buildManagerMcpSetupNotificationBlocks(params: {
  messageText: string;
  notificationId: string;
  configureUrl: string;
  includeActions: boolean;
}): SlackBlock[] {
  const blocks: SlackBlock[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: params.messageText,
      },
    },
  ];

  if (!params.includeActions) {
    return blocks;
  }

  blocks.push({
    type: 'actions',
    block_id: 'manager_mcp_setup_notification',
    elements: [
      {
        type: 'button',
        action_id: MANAGER_MCP_SETUP_CONFIGURE_ACTION_ID,
        text: { type: 'plain_text', text: 'Configure', emoji: true },
        url: params.configureUrl,
        style: 'primary',
        value: params.notificationId,
      },
      {
        type: 'button',
        action_id: MANAGER_MCP_SETUP_NO_THANKS_ACTION_ID,
        text: { type: 'plain_text', text: 'No, thanks', emoji: true },
        value: params.notificationId,
      },
    ],
  });

  return blocks;
}

async function findManagerChannelSettings(): Promise<{
  managerSlackChannelId: string | null;
  hasActiveSlackInstallation: boolean;
}> {
  const [settings, slackInstallation] = await Promise.all([
    getBackgroundAgentSettingsForDeployment(),
    db.query.slackInstallations.findFirst({
      where: eq(slackInstallations.isActive, true),
      columns: {
        botAccessToken: true,
      },
    }),
  ]);

  return {
    managerSlackChannelId: settings.managerSlackChannelId ?? null,
    hasActiveSlackInstallation: Boolean(slackInstallation?.botAccessToken),
  };
}

async function hasExistingManagerMcpSetupNotification(
  serviceId: string,
): Promise<boolean> {
  const existing = await db.query.mcpSetupManagerNotifications.findFirst({
    where: eq(mcpSetupManagerNotifications.serviceId, serviceId),
    columns: { id: true },
  });

  return Boolean(existing);
}

async function getAppUserDisplayName(userId: string): Promise<string | null> {
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { name: true },
  });
  const name = user?.name.trim();
  return name || null;
}

export async function maybeNotifyManagerChannelForMcpSetupRequirement(params: {
  triggeredByUserId: string;
  triggeredBySlackUserId: string;
  requirement: SlackMcpSetupRequirement;
  slack: SlackNotifier;
}): Promise<{ posted: boolean; notificationId?: string; reason?: string }> {
  const { requirement } = params;

  if (!isManagerMcpSetupReason(requirement.reason)) {
    return { posted: false, reason: 'not_deployment_setup' };
  }

  const settings = await findManagerChannelSettings();
  if (!settings.managerSlackChannelId) {
    return { posted: false, reason: 'missing_manager_channel' };
  }

  if (!settings.hasActiveSlackInstallation) {
    return { posted: false, reason: 'missing_active_slack_installation' };
  }

  if (await hasExistingManagerMcpSetupNotification(requirement.serviceId)) {
    return { posted: false, reason: 'already_notified' };
  }

  const redis = getRedis();
  const lockKey = `slack:manager-mcp-setup-notification:${requirement.serviceId}`;
  const lockAcquired = await redis.set(
    lockKey,
    '1',
    'EX',
    MANAGER_MCP_SETUP_NOTIFICATION_LOCK_TTL_SECONDS,
    'NX',
  );

  if (!lockAcquired) {
    return { posted: false, reason: 'notification_lock_held' };
  }

  try {
    if (await hasExistingManagerMcpSetupNotification(requirement.serviceId)) {
      return { posted: false, reason: 'already_notified' };
    }

    const notificationId = randomUUID();
    const userLabel =
      (await getAppUserDisplayName(params.triggeredByUserId)) ??
      `<@${params.triggeredBySlackUserId}>`;
    const configureUrl = buildManagerMcpSetupConfigureUrl(
      requirement.serviceId,
    );
    const messageText = buildManagerMcpSetupMessageText({
      userLabel,
      serviceName: requirement.serviceName,
    });

    const messageTs = await params.slack.postMessage({
      channel: settings.managerSlackChannelId,
      text: messageText,
      blocks: buildManagerMcpSetupNotificationBlocks({
        messageText,
        notificationId,
        configureUrl,
        includeActions: true,
      }),
    });

    if (!messageTs) {
      return { posted: false, reason: 'slack_post_failed' };
    }

    await db
      .insert(mcpSetupManagerNotifications)
      .values({
        id: notificationId,
        serviceId: requirement.serviceId,
        reason: requirement.reason,
        triggeredByUserId: params.triggeredByUserId,
        triggeredBySlackUserId: params.triggeredBySlackUserId,
        messageText,
        channelId: settings.managerSlackChannelId,
        messageTs,
        sentAt: new Date(),
      })
      .onConflictDoNothing({
        target: [mcpSetupManagerNotifications.serviceId],
      });

    return { posted: true, notificationId };
  } catch (error) {
    console.warn(
      `[ManagerMcpSetup] Failed to notify manager channel for service ${requirement.serviceId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { posted: false, reason: 'error' };
  } finally {
    await redis.del(lockKey).catch(() => {});
  }
}

export async function handleManagerMcpSetupConfigure(
  _payload: SlackInteractivePayload,
): Promise<void> {
  // Slack may send an interaction payload for URL buttons. The browser handoff
  // is handled by Slack, so acknowledging the action is enough.
}

export async function handleManagerMcpSetupNoThanks(
  payload: SlackInteractivePayload,
): Promise<void> {
  const notificationId =
    payload.actions[0]?.type === 'button'
      ? (payload.actions[0].value ?? undefined)
      : undefined;

  if (!notificationId) {
    console.warn('[ManagerMcpSetupNoThanks] Missing notification id');
    return;
  }

  const existing = await db.query.mcpSetupManagerNotifications.findFirst({
    where: eq(mcpSetupManagerNotifications.id, notificationId),
    columns: {
      id: true,
      serviceId: true,
      messageText: true,
      dismissedAt: true,
    },
  });

  if (!existing) {
    return;
  }

  const slackUserMapping = await db.query.slackUserMappings.findFirst({
    where: and(
      eq(slackUserMappings.slackTeamId, payload.team.id),
      eq(slackUserMappings.slackUserId, payload.user.id),
    ),
    columns: { userId: true },
  });

  const now = new Date();
  const updateValues: {
    dismissedAt: Date;
    updatedAt: Date;
    dismissedBySlackUserId?: string;
    dismissedByUserId?: string | null;
  } = {
    dismissedAt: existing.dismissedAt ?? now,
    updatedAt: now,
  };

  if (existing.dismissedAt === null) {
    updateValues.dismissedBySlackUserId = payload.user.id;
    updateValues.dismissedByUserId = slackUserMapping?.userId ?? null;
  }

  await db
    .update(mcpSetupManagerNotifications)
    .set(updateValues)
    .where(eq(mcpSetupManagerNotifications.id, notificationId));

  const configureUrl = buildManagerMcpSetupConfigureUrl(existing.serviceId);
  await postSlackInteractiveResponse(payload.response_url, {
    replace_original: true,
    text: existing.messageText,
    blocks: buildManagerMcpSetupNotificationBlocks({
      messageText: existing.messageText,
      notificationId: existing.id,
      configureUrl,
      includeActions: false,
    }),
  });
}
