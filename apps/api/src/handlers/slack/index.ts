import { Hono } from 'hono';

import { type SlackInteractivePayload, SlackNotifier } from '@roomote/slack';
import {
  db,
  eq,
  resolveSlackSigningSecret,
  slackInstallations,
} from '@roomote/db/server';

import { apiLogger } from '../../logging.js';
import { createSlackWebhookContext } from './context.js';
import { dispatchSlackEvent } from './dispatch/events.js';
import {
  claimSlackEvent,
  completeSlackEventClaim,
  releaseSlackEventClaim,
  type SlackEventClaim,
} from './event-gate.js';
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
import { resumePendingSlackAuthRequest } from './events/auth-resume.js';

export const slack = new Hono();

slack.post('/auth/resume', async (c) => {
  let rawBody: unknown;

  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ success: false, error: 'invalid_json' }, { status: 400 });
  }

  const stateToken =
    rawBody &&
    typeof rawBody === 'object' &&
    !Array.isArray(rawBody) &&
    typeof (rawBody as { state?: unknown }).state === 'string'
      ? (rawBody as { state: string }).state.trim()
      : '';

  if (!stateToken) {
    return c.json(
      { success: false, error: 'missing_state_token' },
      { status: 400 },
    );
  }

  const result = await resumePendingSlackAuthRequest(stateToken);

  if (result.success) {
    return c.json(result);
  }

  const status =
    result.error === 'account_link_required' ||
    result.error === 'resume_in_progress' ||
    result.error === 'fast_session_not_accepted'
      ? 409
      : result.error === 'invalid_or_expired_auth_token'
        ? 404
        : 400;

  return c.json(result, { status });
});

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

    let eventClaim: SlackEventClaim | null = null;

    if (eventId) {
      const claimResult = await claimSlackEvent(eventId);

      if (claimResult.status === 'completed') {
        apiLogger.debug(`🔄 Skipping duplicate Slack event: ${eventId}`);
        return c.json({ ok: true });
      }
      if (claimResult.status === 'processing') {
        apiLogger.debug(`⏳ Slack event is still processing: ${eventId}`);
        return c.json(
          { ok: false, error: 'slack_event_processing' },
          { status: 503 },
        );
      }
      eventClaim = claimResult.claim;
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
      if (eventClaim) {
        await completeSlackEventClaim(eventClaim);
      }
      return c.json({ ok: true });
    }

    const context = createSlackWebhookContext({
      slackInstallation,
      slack: new SlackNotifier(slackInstallation.botAccessToken, {
        botUserId: slackInstallation.botUserId,
        botName: slackInstallation.botName,
        appName: slackInstallation.appName,
      }),
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
      if (eventClaim) {
        await completeSlackEventClaim(eventClaim);
      }
    } catch (error) {
      console.error(
        `❌ Failed to process ${event.type}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      if (eventClaim) {
        await releaseSlackEventClaim(eventClaim).catch((releaseError) => {
          console.error(
            `❌ Failed to release Slack event claim ${eventId}: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`,
          );
        });
      }
      return c.json(
        { ok: false, error: 'slack_event_processing_failed' },
        { status: 503 },
      );
    }
  }

  return c.json({ ok: true });
});
