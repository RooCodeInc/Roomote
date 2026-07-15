import { createHmac, timingSafeEqual } from 'node:crypto';

import { Hono } from 'hono';
import { z } from 'zod';

import { resolveDeploymentEnvVar } from '@roomote/db/server';
import { completeRoomoteCloudGitHubInstallation } from '@roomote/github';

import { logApiError } from '../../logging';
import { processGitHubDelivery } from './index';

const CLOUD_SIGNATURE_PREFIX = 'v1=';
const GITHUB_SIGNATURE_PREFIX = 'sha256=';
const MAX_DELIVERY_AGE_SECONDS = 5 * 60;

function secureEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);

  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

export function verifyRoomoteCloudDelivery(input: {
  deliveryId: string;
  payload: string;
  secret: string;
  signature: string;
  timestamp: string;
  nowSeconds?: number;
}): boolean {
  if (!/^\d+$/u.test(input.timestamp)) {
    return false;
  }

  const timestamp = Number(input.timestamp);
  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (
    !Number.isSafeInteger(timestamp) ||
    Math.abs(nowSeconds - timestamp) > MAX_DELIVERY_AGE_SECONDS
  ) {
    return false;
  }

  const expected = `${CLOUD_SIGNATURE_PREFIX}${createHmac(
    'sha256',
    input.secret,
  )
    .update(`${input.timestamp}.${input.deliveryId}.${input.payload}`)
    .digest('hex')}`;

  return secureEqual(input.signature, expected);
}

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
