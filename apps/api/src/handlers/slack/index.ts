import { Hono } from 'hono';

import { getRedis } from '@roomote/redis';
import { type SlackInteractivePayload, SlackNotifier } from '@roomote/slack';
import {
  db,
  eq,
  resolveSlackSigningSecret,
  slackInstallations,
} from '@roomote/db/server';

import { apiLogger } from '../../logging.js';
import { createSlackWebhookContext } from './context.js';
import {
  EVENT_DEDUP_TTL_SECONDS,
  SLACK_EVENT_DEDUP_PREFIX,
} from './constants.js';
import { dispatchSlackEvent } from './dispatch/events.js';
import { handleSlackInteractivePayload } from './dispatch/interactive.js';
import {
  getSlackWebhookEventLogDetails,
  isAppAuthoredSlackEvent,
  isRoomoteAuthoredSlackEvent,
  isRoutableAutomatedSlackAppMention,
  isSlackFunctionExecutedEvent,
} from './helpers/event-normalization.js';
import type { SlackWebhookBody } from './types.js';
import { verifySlackRequest } from './verifySlackRequest.js';
import { lookupSlackUserMapping } from './helpers/user-mapping.js';
import { startAutoRoutedSlackTask } from '@roomote/slack';
import { parseGoalCommand } from '@roomote/communication/goal-command';

export const slack = new Hono();

slack.post('/', async (c) => {
  const headers = c.req.header();
  const rawBody = await c.req.text();

  const signingSecret = await resolveSlackSigningSecret();

  if (!signingSecret) {
    console.error(
      '❌ Slack request rejected: signing secret is not configured',
    );

    return c.json(
      { error: 'slack_signing_secret_not_configured' },
      { status: 503 },
    );
  }

  const verification = verifySlackRequest(
    headers['x-slack-signature'],
    headers['x-slack-request-timestamp'],
    rawBody,
    signingSecret,
  );

  if (!verification.isValid) {
    console.error(
      `❌ Slack request verification failed: ${verification.error}`,
    );

    return c.json({}, { status: 401 });
  }

  if (headers['content-type']?.includes('application/x-www-form-urlencoded')) {
    const formData = new URLSearchParams(rawBody);
    const payload = formData.get('payload');

    if (payload) {
      let interactivePayload: SlackInteractivePayload;

      try {
        interactivePayload = JSON.parse(payload) as SlackInteractivePayload;
      } catch (error) {
        console.error(
          `❌ Failed to parse interactive payload: ${error instanceof Error ? error.message : String(error)}`,
        );

        return c.json({ ok: true });
      }

      void handleSlackInteractivePayload(interactivePayload).catch((error) => {
        const actionId =
          interactivePayload.type === 'block_actions'
            ? interactivePayload.actions[0]?.action_id
            : undefined;
        console.error(
          `❌ Failed to handle interactive payload${actionId ? ` action ${actionId}` : ''}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });

      return c.json({ ok: true });
    }

    if (formData.get('command') === '/goal') {
      const teamId = formData.get('team_id');
      const slackUserId = formData.get('user_id');
      const channel = formData.get('channel_id');
      const parsedGoal = parseGoalCommand(
        `/goal ${formData.get('text') ?? ''}`,
      );
      if (!teamId || !slackUserId || !channel || !parsedGoal?.goal) {
        return c.json({
          response_type: 'ephemeral',
          text: 'Send an objective after the command — for example, `/goal ship the release`.',
        });
      }

      const [slackInstallation] = await db
        .select()
        .from(slackInstallations)
        .where(eq(slackInstallations.teamId, teamId))
        .limit(1);
      const { activeMapping } = await lookupSlackUserMapping({
        slackUserId,
        teamId,
      });
      if (!slackInstallation || !activeMapping) {
        return c.json({
          response_type: 'ephemeral',
          text: 'Link this Slack account to Roomote before starting Goal Mode.',
        });
      }

      void startAutoRoutedSlackTask({
        slackInstallation,
        slack: new SlackNotifier(slackInstallation.botAccessToken),
        initiator: { kind: 'user', userId: activeMapping.userId },
        trigger: 'message',
        launchUserId: activeMapping.userId,
        slackUserId,
        persistedSlackUserId: slackUserId,
        channel,
        prompt: `/goal ${parsedGoal.objective}`,
      }).catch((error) => {
        apiLogger.error(
          `[slack] Failed to handle /goal command: ${error instanceof Error ? error.message : String(error)}`,
        );
      });

      return c.json({
        response_type: 'ephemeral',
        text: 'Starting Goal Mode…',
      });
    }
  }

  const body: SlackWebhookBody = JSON.parse(rawBody);

  if (body.type === 'url_verification') {
    apiLogger.debug('🔐 Slack URL verification challenge received');
    return c.json({ challenge: body.challenge });
  }

  if (body.type === 'event_callback' && body.event) {
    const event = body.event;
    const teamId = body.team_id;
    const eventId = body.event_id;

    if (!teamId) {
      console.error('❌ No team_id found in webhook payload');
      return c.json({ error: 'team_id is required' }, { status: 400 });
    }

    const [slackInstallation] = await db
      .select()
      .from(slackInstallations)
      .where(eq(slackInstallations.teamId, teamId))
      .limit(1);

    if (!slackInstallation) {
      console.error(`❌ No Slack installation found for team ID: ${teamId}`);

      return c.json({ error: 'Slack installation not found' }, { status: 404 });
    }

    if (eventId) {
      const eventDedupKey = `${SLACK_EVENT_DEDUP_PREFIX}${eventId}`;
      const redis = getRedis();

      const claimed = await redis.set(
        eventDedupKey,
        '1',
        'EX',
        EVENT_DEDUP_TTL_SECONDS,
        'NX',
      );

      if (!claimed) {
        apiLogger.debug(`🔄 Skipping duplicate Slack event: ${eventId}`);
        return c.json({ ok: true });
      }
    }

    const isAppAuthoredEvent = isAppAuthoredSlackEvent(event);
    const automatedAppMentionEvent = isRoutableAutomatedSlackAppMention(
      event,
      slackInstallation,
    )
      ? event
      : null;
    const isTopLevelAppMessageEvent =
      event.type === 'message' && !event.thread_ts;

    if (
      isAppAuthoredEvent &&
      !automatedAppMentionEvent &&
      (!isTopLevelAppMessageEvent ||
        isRoomoteAuthoredSlackEvent(event, slackInstallation))
    ) {
      return c.json({ ok: true });
    }

    const context = createSlackWebhookContext({
      slackInstallation,
      slack: new SlackNotifier(slackInstallation.botAccessToken),
      teamId,
    });
    const eventLogDetails = getSlackWebhookEventLogDetails(event);
    const callbackLog = eventLogDetails.callbackId
      ? `callback_id: ${eventLogDetails.callbackId}, `
      : '';
    const threadTsLabel = isSlackFunctionExecutedEvent(event)
      ? 'message_ts'
      : 'thread_ts';

    apiLogger.debug(
      `🛎️ Slack Event -> type: ${event.type}, ` +
        `subtype: ${eventLogDetails.subtype}, ` +
        callbackLog +
        `event_id: ${eventId}, ` +
        `channel: ${eventLogDetails.channel}, ` +
        `team_id: ${teamId}, ` +
        `user: ${eventLogDetails.user}, ` +
        `${threadTsLabel}: ${eventLogDetails.threadTs}, ` +
        `ts: ${eventLogDetails.ts} ` +
        `text: ${eventLogDetails.text}`,
    );

    try {
      await dispatchSlackEvent({
        event,
        context,
      });
    } catch (error) {
      console.error(
        `❌ Failed to process ${event.type}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  return c.json({ ok: true });
});
