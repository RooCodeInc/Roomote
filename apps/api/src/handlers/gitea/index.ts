import { createHash } from 'node:crypto';

import { Hono } from 'hono';

import { resolveDeploymentEnvVar } from '@roomote/db/server';
import { handleMergeAnnouncerPush } from '@roomote/sdk/server';

import { apiLogger, logApiError } from '../../logging';
import { recordWebhook } from '../github/recordWebhook';
import { normalizeGiteaPush } from '../merge-announcer-push';
import { handleGiteaComment } from './handleComment';
import { handleGiteaIssue } from './handleIssue';
import { handleGiteaPullRequest } from './handlePullRequest';
import { handleGiteaWorkflowRun } from './handleWorkflowRun';
import {
  giteaIssueWebhookSchema,
  giteaPullRequestCommentWebhookSchema,
  giteaPullRequestWebhookSchema,
  giteaPushWebhookSchema,
  giteaWorkflowRunWebhookSchema,
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
    const secretToken = await resolveDeploymentEnvVar('GITEA_WEBHOOK_SECRET');
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

    if (eventName === 'pull_request_comment' || eventName === 'issue_comment') {
      const payload = giteaPullRequestCommentWebhookSchema.parse(parsedJson);
      // pull_request_comment is always PR-scoped. issue_comment may be either a
      // PR discussion (is_pull === true) or a plain issue (is_pull !== true).
      // Plain-issue mentions are handled inside handleGiteaComment.

      await recordWebhook(
        deliveryId,
        `${eventName}.${payload.action}`,
        payload,
        async () => {
          const result = await handleGiteaComment(payload, {
            forcePullRequestComment: eventName === 'pull_request_comment',
          });
          apiLogger.info?.(
            `[Gitea] ${eventName}.${payload.action} delivery ${deliveryId}: ${result.message ?? result.status}`,
          );
          return result;
        },
        { provider: 'gitea' },
      );

      return c.json({ message: 'webhook_processed' });
    }

    if (eventName === 'issues') {
      const payload = giteaIssueWebhookSchema.parse(parsedJson);

      await recordWebhook(
        deliveryId,
        `issues.${payload.action}`,
        payload,
        () => handleGiteaIssue(payload),
        { provider: 'gitea' },
      );

      return c.json({ message: 'webhook_processed' });
    }

    if (eventName === 'workflow_run') {
      const payload = giteaWorkflowRunWebhookSchema.parse(parsedJson);

      await recordWebhook(
        deliveryId,
        `workflow_run.${payload.action ?? 'unknown'}`,
        payload,
        () => handleGiteaWorkflowRun(payload),
        { provider: 'gitea' },
      );

      return c.json({ message: 'webhook_processed' });
    }

    if (eventName === 'push') {
      const payload = giteaPushWebhookSchema.parse(parsedJson);

      await recordWebhook(
        deliveryId,
        'push',
        payload,
        () => handleMergeAnnouncerPush(normalizeGiteaPush(payload)),
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
