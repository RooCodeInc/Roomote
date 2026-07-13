import { createHash } from 'node:crypto';

import { Hono } from 'hono';

import { resolveDeploymentEnvVar } from '@roomote/db/server';

import { apiLogger, logApiError } from '../../logging';
import { recordWebhook } from '../github/recordWebhook';
import { handleGitLabMergeRequest } from './handleMergeRequest';
import { handleGitLabNote } from './handleNote';
import {
  gitLabMergeRequestWebhookSchema,
  gitLabNoteWebhookSchema,
} from './types';
import { verifyGitLabWebhook } from './verifyWebhook';

export const gitlab = new Hono();

function getGitLabDeliveryId({
  body,
  headers,
}: {
  body: string;
  headers: Record<string, string | undefined>;
}): string {
  return (
    headers['webhook-id'] ??
    headers['x-gitlab-webhook-uuid'] ??
    createHash('sha256').update(body).digest('hex')
  );
}

gitlab.post('/', async (c) => {
  try {
    const headers = c.req.header();
    const body = await c.req.text();

    // Resolve through the deployment env resolver so secrets saved into
    // encrypted environment_variables by /setup or Settings verify without
    // also being copied into the process environment.
    const [secretToken, signingToken] = await Promise.all([
      resolveDeploymentEnvVar('R_GITLAB_WEBHOOK_SECRET'),
      resolveDeploymentEnvVar('R_GITLAB_WEBHOOK_SIGNING_TOKEN'),
    ]);

    const verified = verifyGitLabWebhook({
      body,
      headers,
      secretToken: secretToken ?? undefined,
      signingToken: signingToken ?? undefined,
    });

    if (!verified) {
      apiLogger.debug('[GitLab] invalid webhook signature or token');
      return c.json({ error: 'invalid_signature' }, { status: 401 });
    }

    const parsedJson = JSON.parse(body) as unknown;
    const eventName = headers['x-gitlab-event'] ?? 'unknown';
    const deliveryId = getGitLabDeliveryId({ body, headers });

    if (eventName === 'Note Hook') {
      const payload = gitLabNoteWebhookSchema.parse(parsedJson);

      await recordWebhook(
        deliveryId,
        `note.${payload.object_attributes.noteable_type ?? 'unknown'}`,
        payload,
        () => handleGitLabNote(payload),
        { provider: 'gitlab' },
      );

      return c.json({ message: 'webhook_processed' });
    }

    if (eventName !== 'Merge Request Hook') {
      await recordWebhook(
        deliveryId,
        eventName,
        parsedJson,
        async () => ({
          status: 'ok',
          message: `unsupported_gitlab_event:${eventName}`,
        }),
        { provider: 'gitlab' },
      );

      return c.json({ message: 'webhook_processed' });
    }

    const payload = gitLabMergeRequestWebhookSchema.parse(parsedJson);
    const action = payload.object_attributes.action;

    await recordWebhook(
      deliveryId,
      `merge_request.${action}`,
      payload,
      () => handleGitLabMergeRequest(payload),
      { provider: 'gitlab' },
    );

    return c.json({ message: 'webhook_processed' });
  } catch (error) {
    logApiError('[GitLab] caught error', error);

    if (error instanceof SyntaxError) {
      return c.json({ error: 'invalid_json' }, { status: 400 });
    }

    return c.json({ error: 'internal_server_error' }, { status: 500 });
  }
});
