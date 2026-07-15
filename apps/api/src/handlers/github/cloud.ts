import { createHmac } from 'node:crypto';

import { Hono } from 'hono';
import { z } from 'zod';

import { resolveDeploymentEnvVar } from '@roomote/db/server';
import { completeRoomoteCloudGitHubInstallation } from '@roomote/github';
import { isRoomoteCloudEnabled } from '@roomote/types';

import { logApiError } from '../../logging';
import { verifyRoomoteCloudDelivery } from '../cloud-delivery';
import { processGitHubDelivery } from './index';

const GITHUB_SIGNATURE_PREFIX = 'sha256=';
export { verifyRoomoteCloudDelivery } from '../cloud-delivery';

function signAsGitHubDelivery(payload: string, secret: string): string {
  return `${GITHUB_SIGNATURE_PREFIX}${createHmac('sha256', secret)
    .update(payload)
    .digest('hex')}`;
}

export const cloudGitHub = new Hono();

const installationSetupSchema = z.object({
  installationId: z.string().regex(/^\d+$/u),
  appId: z.number().int().positive(),
  accountLogin: z.string().min(1).max(255),
  accountType: z.enum(['Organization', 'User']),
  permissions: z.record(z.string()),
});

cloudGitHub.post('/', async (c) => {
  if (!isRoomoteCloudEnabled(process.env)) {
    return c.notFound();
  }

  try {
    const headers = c.req.header();
    const provider = headers['x-roomote-cloud-provider'];
    const id = headers['x-roomote-cloud-delivery'];
    const name = headers['x-roomote-cloud-event'];
    const timestamp = headers['x-roomote-cloud-timestamp'];
    const signature = headers['x-roomote-cloud-signature'];

    if (provider !== 'github' || !id || !name || !timestamp || !signature) {
      return c.json({ error: 'missing_headers' }, 400);
    }

    const secret = await resolveDeploymentEnvVar(
      'ROOMOTE_CLOUD_INTEGRATION_SECRET',
    );
    if (!secret) {
      return c.json({ error: 'cloud_integration_not_configured' }, 503);
    }

    const payload = await c.req.text();
    if (
      !verifyRoomoteCloudDelivery({
        deliveryId: id,
        provider,
        eventName: name,
        payload,
        secret,
        signature,
        timestamp,
      })
    ) {
      return c.json({ error: 'invalid_signature' }, 401);
    }

    await processGitHubDelivery({
      id,
      name,
      payload,
      secret,
      signature: signAsGitHubDelivery(payload, secret),
    });

    return c.json({ message: 'webhook_processed' });
  } catch (error) {
    logApiError('[Roomote Cloud GitHub] caught error', error);
    return c.json({ error: 'internal_server_error' }, 500);
  }
});

cloudGitHub.post('/setup', async (c) => {
  if (!isRoomoteCloudEnabled(process.env)) {
    return c.notFound();
  }

  const headers = c.req.header();
  const provider = headers['x-roomote-cloud-provider'];
  const id = headers['x-roomote-cloud-delivery'];
  const name = headers['x-roomote-cloud-event'];
  const timestamp = headers['x-roomote-cloud-timestamp'];
  const signature = headers['x-roomote-cloud-signature'];

  if (
    provider !== 'github' ||
    name !== 'installation.setup' ||
    !id ||
    !timestamp ||
    !signature
  ) {
    return c.json({ error: 'missing_headers' }, 400);
  }

  const secret = await resolveDeploymentEnvVar(
    'ROOMOTE_CLOUD_INTEGRATION_SECRET',
  );
  if (!secret) {
    return c.json({ error: 'cloud_integration_not_configured' }, 503);
  }

  const payload = await c.req.text();
  if (
    !verifyRoomoteCloudDelivery({
      deliveryId: id,
      provider,
      eventName: name,
      payload,
      secret,
      signature,
      timestamp,
    })
  ) {
    return c.json({ error: 'invalid_signature' }, 401);
  }

  let setup: z.infer<typeof installationSetupSchema>;
  try {
    setup = installationSetupSchema.parse(JSON.parse(payload));
  } catch {
    return c.json({ error: 'invalid_payload' }, 400);
  }

  try {
    const result = await completeRoomoteCloudGitHubInstallation({
      ...setup,
      installationId: Number(setup.installationId),
    });
    return c.json({
      installationId: result.githubInstallation.installationId,
      repositories: result.repositories.length,
      synchronized: true,
    });
  } catch (error) {
    logApiError('[Roomote Cloud GitHub] setup failed', error);
    return c.json({ error: 'installation_sync_pending' }, 409);
  }
});
