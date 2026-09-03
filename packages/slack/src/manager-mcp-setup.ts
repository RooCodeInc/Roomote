import { Env } from '@roomote/env';
import type { SlackBlock } from '@roomote/types';
import {
  and,
  db,
  eq,
  slackUserMappings,
  trackedMessages,
} from '@roomote/db/server';

import type { SlackInteractivePayload } from './types';
import { postSlackInteractiveResponse } from './interactive-response';

/**
 * Button handlers for the manager-channel MCP setup nudge. New nudges are no
 * longer posted (the router that detected setup requirements is gone), but
 * buttons on messages already in Slack still land here.
 */
export const MANAGER_MCP_SETUP_CONFIGURE_ACTION_ID =
  'manager_mcp_setup_configure';
export const MANAGER_MCP_SETUP_NO_THANKS_ACTION_ID =
  'manager_mcp_setup_no_thanks';

function buildManagerMcpSetupConfigureUrl(serviceId: string): string {
  const url = new URL('/settings/integrations', Env.R_APP_URL);
  url.searchParams.set('service', serviceId);
  url.searchParams.set('source', 'slack-manager-integration-setup');
  return url.toString();
}

function buildManagerMcpSetupNotificationBlocks(params: {
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

  const existing = await db.query.trackedMessages.findFirst({
    where: and(
      eq(trackedMessages.kind, 'mcp_setup_nudge'),
      eq(trackedMessages.id, notificationId),
    ),
    columns: {
      id: true,
      dedupeKey: true,
      summaryText: true,
      dismissedAt: true,
      metadata: true,
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
  const nextMetadata: Record<string, unknown> = { ...existing.metadata };

  if (existing.dismissedAt === null) {
    nextMetadata.dismissedBySlackUserId = payload.user.id;
    nextMetadata.dismissedByUserId = slackUserMapping?.userId ?? null;
  }

  await db
    .update(trackedMessages)
    .set({
      dismissedAt: existing.dismissedAt ?? now,
      updatedAt: now,
      metadata: nextMetadata,
    })
    .where(eq(trackedMessages.id, notificationId));

  const configureUrl = buildManagerMcpSetupConfigureUrl(existing.dedupeKey);
  await postSlackInteractiveResponse(payload.response_url, {
    replace_original: true,
    text: existing.summaryText,
    blocks: buildManagerMcpSetupNotificationBlocks({
      messageText: existing.summaryText,
      notificationId: existing.id,
      configureUrl,
      includeActions: false,
    }),
  });
}
