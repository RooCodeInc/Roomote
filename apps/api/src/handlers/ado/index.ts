import { createHash } from 'node:crypto';

import { Hono } from 'hono';

import { resolveDeploymentEnvVar } from '@roomote/db/server';

import { apiLogger, logApiError } from '../../logging';
import { recordWebhook } from '../github/recordWebhook';
import {
  type AdoUpdatedNotificationType,
  handleAdoPullRequest,
} from './handlePullRequest';
import { handleAdoComment } from './handleComment';
import { normalizeAdoCommentWebhookPayload } from './normalizeCommentWebhook';
import {
  adoPullRequestCommentWebhookSchema,
  adoPullRequestWebhookSchema,
} from './types';
import { verifyAdoWebhook } from './verifyWebhook';

export const ado = new Hono();

const ADO_PULL_REQUEST_EVENTS = new Set([
  'git.pullrequest.created',
  'git.pullrequest.updated',
]);
const ADO_PULL_REQUEST_COMMENT_EVENT =
  'ms.vss-code.git-pullrequest-comment-event';

function getAdoUpdatedNotificationType(
  value: string | undefined,
): AdoUpdatedNotificationType | undefined {
  if (value === 'PushNotification' || value === 'StatusUpdateNotification') {
    return value;
  }

  return undefined;
}

function getAdoDeliveryId({
  body,
  payload,
}: {
  body: string;
  payload: unknown;
}): string {
  if (typeof payload === 'object' && payload !== null) {
    const possibleDelivery = payload as {
      id?: unknown;
      notificationId?: unknown;
    };

    if (typeof possibleDelivery.id === 'string' && possibleDelivery.id) {
      return possibleDelivery.id;
    }

    if (
      typeof possibleDelivery.notificationId === 'string' ||
      typeof possibleDelivery.notificationId === 'number'
    ) {
      return String(possibleDelivery.notificationId);
    }
  }

  return createHash('sha256').update(body).digest('hex');
}

function getAdoEventName(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) {
    return 'unknown';
  }

  const eventType = (payload as { eventType?: unknown }).eventType;

  return typeof eventType === 'string' && eventType.trim()
    ? eventType
    : 'unknown';
}

ado.post('/', async (c) => {
  try {
    const headers = c.req.header();
    const body = await c.req.text();
    const secretToken = await resolveDeploymentEnvVar('ADO_WEBHOOK_SECRET');
    const verified = verifyAdoWebhook({
      headers,
      secretToken: secretToken ?? undefined,
    });

    if (!verified) {
      apiLogger.debug('[ADO] invalid webhook secret');
      return c.json({ error: 'invalid_signature' }, { status: 401 });
    }

    const parsedJson = JSON.parse(body) as unknown;
    const eventName = getAdoEventName(parsedJson);
    const deliveryId = getAdoDeliveryId({ body, payload: parsedJson });

    if (eventName === ADO_PULL_REQUEST_COMMENT_EVENT) {
      const payload = adoPullRequestCommentWebhookSchema.parse(
        await normalizeAdoCommentWebhookPayload(parsedJson),
      );

      await recordWebhook(
        deliveryId,
        eventName,
        payload,
        () => handleAdoComment(payload),
        { provider: 'ado' },
      );

      return c.json({ message: 'webhook_processed' });
    }

    if (!ADO_PULL_REQUEST_EVENTS.has(eventName)) {
      await recordWebhook(
        deliveryId,
        eventName,
        parsedJson,
        async () => ({
          status: 'ok',
          message: `unsupported_ado_event:${eventName}`,
        }),
        { provider: 'ado' },
      );

      return c.json({ message: 'webhook_processed' });
    }

    const payload = adoPullRequestWebhookSchema.parse(parsedJson);
    const updatedNotificationType = getAdoUpdatedNotificationType(
      c.req.query('notificationType'),
    );

    await recordWebhook(
      deliveryId,
      eventName,
      payload,
      updatedNotificationType
        ? () => handleAdoPullRequest(payload, { updatedNotificationType })
        : () => handleAdoPullRequest(payload),
      { provider: 'ado' },
    );

    return c.json({ message: 'webhook_processed' });
  } catch (error) {
    logApiError('[ADO] caught error', error);

    if (error instanceof SyntaxError) {
      return c.json({ error: 'invalid_json' }, { status: 400 });
    }

    return c.json({ error: 'internal_server_error' }, { status: 500 });
  }
});
