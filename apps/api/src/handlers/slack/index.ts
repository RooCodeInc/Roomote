import { Hono } from 'hono';
import { z } from 'zod';

import { getRedis } from '@roomote/redis';
import { type SlackInteractivePayload, SlackNotifier } from '@roomote/slack';
import {
  db,
  asc,
  and,
  eq,
  isNull,
  resolveDeploymentEnvVar,
  resolveSlackSigningSecret,
  slackInstallations,
  slackUserMappings,
  users,
} from '@roomote/db/server';
import { isRoomoteCloudEnabled } from '@roomote/types';

import { apiLogger } from '../../logging.js';
import { verifyRoomoteCloudDelivery } from '../cloud-delivery.js';
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

export const slack = new Hono();
const CLOUD_SLACK_PATH = '/api/webhooks/cloud/slack';

function isCloudSlackPath(path: string): boolean {
  return path === CLOUD_SLACK_PATH || path.startsWith(`${CLOUD_SLACK_PATH}/`);
}

const cloudSlackSetupSchema = z.object({
  teamId: z.string().min(1),
  teamName: z.string().min(1),
  appId: z.string().min(1),
  botUserId: z.string().min(1),
  botAccessToken: z.string().min(1),
  scopes: z.array(z.string()),
  tokenType: z.string().min(1),
  authedUserId: z.string().min(1).nullable(),
});

type CloudSlackSetup = z.infer<typeof cloudSlackSetupSchema>;

async function completeRoomoteCloudSlackInstallation(setup: CloudSlackSetup) {
  const existingInstallation = await db.query.slackInstallations.findFirst({
    where: eq(slackInstallations.teamId, setup.teamId),
  });
  const admin = existingInstallation
    ? null
    : await db.query.users.findFirst({
        where: and(eq(users.role, 'admin'), isNull(users.deletedAt)),
        orderBy: [asc(users.createdAt)],
      });
  const installedByUserId =
    existingInstallation?.installedByUserId ?? admin?.id;

  if (!installedByUserId) {
    throw new Error(
      'A Roomote administrator must sign in before Slack can be connected.',
    );
  }

  const now = new Date();
  return db.transaction(async (tx) => {
    const [installation] = await tx
      .insert(slackInstallations)
      .values({
        teamId: setup.teamId,
        teamName: setup.teamName,
        appId: setup.appId,
        botUserId: setup.botUserId,
        botAccessToken: setup.botAccessToken,
        scopes: { bot: setup.scopes, user: [] },
        tokenType: setup.tokenType,
        installedByUserId,
        isActive: true,
        lastUsedAt: now,
      })
      .onConflictDoUpdate({
        target: slackInstallations.teamId,
        set: {
          teamName: setup.teamName,
          appId: setup.appId,
          botUserId: setup.botUserId,
          botAccessToken: setup.botAccessToken,
          scopes: { bot: setup.scopes, user: [] },
          tokenType: setup.tokenType,
          installedByUserId,
          isActive: true,
          lastUsedAt: now,
          updatedAt: now,
        },
      })
      .returning();

    if (!installation) throw new Error('Slack installation was not saved.');
    if (setup.authedUserId) {
      await tx
        .insert(slackUserMappings)
        .values({
          slackUserId: setup.authedUserId,
          slackTeamId: setup.teamId,
          userId: installedByUserId,
        })
        .onConflictDoUpdate({
          target: [
            slackUserMappings.slackUserId,
            slackUserMappings.slackTeamId,
          ],
          set: { userId: installedByUserId, updatedAt: now },
        });
    }
    return installation;
  });
}

async function verifyCloudSlackRequest(input: {
  headers: Record<string, string>;
  rawBody: string;
  expectedEvent?: string;
}): Promise<
  { ok: true } | { ok: false; status: 400 | 401 | 503; error: string }
> {
  const id = input.headers['x-roomote-cloud-delivery'];
  const event = input.headers['x-roomote-cloud-event'];
  const timestamp = input.headers['x-roomote-cloud-timestamp'];
  const signature = input.headers['x-roomote-cloud-signature'];
  if (
    input.headers['x-roomote-cloud-provider'] !== 'slack' ||
    !id ||
    !event ||
    !timestamp ||
    !signature ||
    (input.expectedEvent && event !== input.expectedEvent)
  )
    return { ok: false, status: 400, error: 'missing_headers' };
  const secret = await resolveDeploymentEnvVar(
    'ROOMOTE_CLOUD_INTEGRATION_SECRET',
  );
  if (!secret)
    return {
      ok: false,
      status: 503,
      error: 'cloud_integration_not_configured',
    };
  if (
    !verifyRoomoteCloudDelivery({
      deliveryId: id,
      provider: 'slack',
      eventName: event,
      payload: input.rawBody,
      secret,
      signature,
      timestamp,
    })
  )
    return { ok: false, status: 401, error: 'invalid_signature' };
  return { ok: true };
}

slack.post('/', async (c) => {
  const headers = c.req.header();
  const rawBody = await c.req.text();
  if (isCloudSlackPath(c.req.path)) {
    if (!isRoomoteCloudEnabled(process.env)) return c.notFound();
    const verification = await verifyCloudSlackRequest({ headers, rawBody });
    if (!verification.ok)
      return c.json(
        { error: verification.error },
        { status: verification.status },
      );
  } else {
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

      if (isCloudSlackPath(c.req.path)) {
        const deliveryId = headers['x-roomote-cloud-delivery']!;
        const claimed = await getRedis().set(
          `${SLACK_EVENT_DEDUP_PREFIX}cloud:${deliveryId}`,
          '1',
          'EX',
          EVENT_DEDUP_TTL_SECONDS,
          'NX',
        );
        if (!claimed) {
          apiLogger.debug(
            `🔄 Skipping duplicate Roomote Cloud Slack delivery: ${deliveryId}`,
          );
          return c.json({ ok: true, duplicate: true });
        }
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

slack.post('/setup', async (c) => {
  if (!isCloudSlackPath(c.req.path) || !isRoomoteCloudEnabled(process.env))
    return c.notFound();
  const rawBody = await c.req.text();
  const verification = await verifyCloudSlackRequest({
    headers: c.req.header(),
    rawBody,
    expectedEvent: 'installation.setup',
  });
  if (!verification.ok)
    return c.json(
      { error: verification.error },
      { status: verification.status },
    );
  const parsed = cloudSlackSetupSchema.safeParse(
    (() => {
      try {
        return JSON.parse(rawBody) as unknown;
      } catch {
        return null;
      }
    })(),
  );
  if (!parsed.success)
    return c.json({ error: 'invalid_payload' }, { status: 400 });
  try {
    const installation = await completeRoomoteCloudSlackInstallation(
      parsed.data,
    );
    return c.json({
      teamId: installation.teamId,
      synchronized: true,
    });
  } catch (error) {
    apiLogger.warn(
      `[slack] Managed installation setup is pending: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return c.json({ error: 'installation_sync_pending' }, { status: 409 });
  }
});
