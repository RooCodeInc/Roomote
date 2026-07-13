import { createHash } from 'node:crypto';

import { Hono } from 'hono';

import { resolveDeploymentEnvVar } from '@roomote/db/server';

import { apiLogger, logApiError } from '../../logging';
import { recordWebhook } from '../github/recordWebhook';
import { handleBitbucketComment } from './handleComment';
import { handleBitbucketPullRequest } from './handlePullRequest';
import {
  bitbucketPullRequestCommentWebhookSchema,
  bitbucketPullRequestWebhookSchema,
} from './types';
import { verifyBitbucketWebhook } from './verifyWebhook';

export const bitbucket = new Hono();

const BITBUCKET_PULLREQUEST_EVENTS = new Set([
  'pullrequest:created',
  'pullrequest:updated',
  'pullrequest:fulfilled',
  'pullrequest:rejected',
]);

const BITBUCKET_COMMENT_EVENTS = new Set([
  'pullrequest:comment_created',
  'pullrequest:comment_updated',
]);

function getBitbucketDeliveryId({
  body,
  headers,
}: {
  body: string;
  headers: Record<string, string | undefined>;
}): string {
  return (
    headers['x-request-uuid'] ??
    headers['x-hook-uuid'] ??
    createHash('sha256').update(body).digest('hex')
  );
}

function getBitbucketEventName(
  headers: Record<string, string | undefined>,
): string {
  return headers['x-event-key'] ?? 'unknown';
}

bitbucket.post('/', async (c) => {
  try {
    const headers = c.req.header();
    const body = await c.req.text();
    const secretToken = await resolveDeploymentEnvVar(
      'R_BITBUCKET_WEBHOOK_SECRET',
    );
    const verified = verifyBitbucketWebhook({
      body,
      headers,
      secretToken: secretToken ?? undefined,
    });

    if (!verified) {
      apiLogger.debug('[Bitbucket] invalid webhook signature');
      return c.json({ error: 'invalid_signature' }, { status: 401 });
    }

    const parsedJson = JSON.parse(body) as unknown;
    const eventName = getBitbucketEventName(headers);
    const deliveryId = getBitbucketDeliveryId({ body, headers });

    if (BITBUCKET_COMMENT_EVENTS.has(eventName)) {
      const payload =
        bitbucketPullRequestCommentWebhookSchema.parse(parsedJson);

      await recordWebhook(
        deliveryId,
        eventName,
        payload,
        () => handleBitbucketComment(payload, eventName),
        { provider: 'bitbucket' },
      );

      return c.json({ message: 'webhook_processed' });
    }

    if (!BITBUCKET_PULLREQUEST_EVENTS.has(eventName)) {
      await recordWebhook(
        deliveryId,
        eventName,
        parsedJson,
        async () => ({
          status: 'ok',
          message: `unsupported_bitbucket_event:${eventName}`,
        }),
        { provider: 'bitbucket' },
      );

      return c.json({ message: 'webhook_processed' });
    }

    const payload = bitbucketPullRequestWebhookSchema.parse(parsedJson);

    await recordWebhook(
      deliveryId,
      eventName,
      payload,
      () => handleBitbucketPullRequest(payload, eventName),
      { provider: 'bitbucket' },
    );

    return c.json({ message: 'webhook_processed' });
  } catch (error) {
    logApiError('[Bitbucket] caught error', error);

    if (error instanceof SyntaxError) {
      return c.json({ error: 'invalid_json' }, { status: 400 });
    }

    return c.json({ error: 'internal_server_error' }, { status: 500 });
  }
});
