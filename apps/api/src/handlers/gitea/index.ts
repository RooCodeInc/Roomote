import { createHash } from 'node:crypto';

import { Hono } from 'hono';

import { resolveDeploymentEnvVar } from '@roomote/db/server';

import { apiLogger, logApiError } from '../../logging';
import { recordWebhook } from '../github/recordWebhook';
import { handleGiteaComment } from './handleComment';
import { handleGiteaPullRequest } from './handlePullRequest';
import {
  giteaPullRequestCommentWebhookSchema,
  giteaPullRequestWebhookSchema,
} from './types';
import { verifyGiteaWebhook } from './verifyWebhook';

export const gitea = new Hono();

function getGiteaDeliveryId({
  body,
  headers,
}: {
  body: string;
  headers: Record<string, string | undefined>;
}): string {
  return (
    headers['x-gitea-delivery'] ??
    headers['x-gogs-delivery'] ??
    headers['x-github-delivery'] ??
    createHash('sha256').update(body).digest('hex')
  );
}

function getGiteaEventName(
  headers: Record<string, string | undefined>,
): string {
  return (
    headers['x-gitea-event'] ??
    headers['x-gogs-event'] ??
    headers['x-github-event'] ??
    'unknown'
  );
}

gitea.post('/', async (c) => {
  try {
    const headers = c.req.header();
    const body = await c.req.text();
    const secretToken = await resolveDeploymentEnvVar('R_GITEA_WEBHOOK_SECRET');
    const verified = verifyGiteaWebhook({
      body,
      headers,
      secretToken: secretToken ?? undefined,
    });

    if (!verified) {
      apiLogger.debug('[Gitea] invalid webhook signature');
      return c.json({ error: 'invalid_signature' }, { status: 401 });
    }

    const parsedJson = JSON.parse(body) as unknown;
    const eventName = getGiteaEventName(headers);
    const deliveryId = getGiteaDeliveryId({ body, headers });

    if (
      eventName === 'pull_request_comment' ||
      (eventName === 'issue_comment' &&
        typeof parsedJson === 'object' &&
        parsedJson !== null &&
        (parsedJson as { is_pull?: unknown }).is_pull === true)
    ) {
      const payload = giteaPullRequestCommentWebhookSchema.parse(parsedJson);

      await recordWebhook(
        deliveryId,
        `${eventName}.${payload.action}`,
        payload,
        () => handleGiteaComment(payload),
        { provider: 'gitea' },
      );

      return c.json({ message: 'webhook_processed' });
    }

    if (eventName !== 'pull_request' && eventName !== 'pull_request_sync') {
      await recordWebhook(
        deliveryId,
        eventName,
        parsedJson,
        async () => ({
          status: 'ok',
          message: `unsupported_gitea_event:${eventName}`,
        }),
        { provider: 'gitea' },
      );

      return c.json({ message: 'webhook_processed' });
    }

    const payload = giteaPullRequestWebhookSchema.parse(parsedJson);

    await recordWebhook(
      deliveryId,
      `${eventName}.${payload.action}`,
      payload,
      () => handleGiteaPullRequest(payload),
      { provider: 'gitea' },
    );

    return c.json({ message: 'webhook_processed' });
  } catch (error) {
    logApiError('[Gitea] caught error', error);

    if (error instanceof SyntaxError) {
      return c.json({ error: 'invalid_json' }, { status: 400 });
    }

    return c.json({ error: 'internal_server_error' }, { status: 500 });
  }
});
