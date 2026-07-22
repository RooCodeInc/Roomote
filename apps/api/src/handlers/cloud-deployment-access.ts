import { createHmac, timingSafeEqual } from 'node:crypto';

import { Hono } from 'hono';

import { Env, isRoomoteCloudEnabled } from '@roomote/env';
import {
  managedAccessDecisionSchema,
  type ManagedAccessDecision,
  type ManagedDeploymentAccess,
} from '@roomote/types';
import {
  applyManagedDeploymentAccessDecision,
  StaleManagedAccessDecisionError,
} from '@roomote/db/server';

const TOKEN_PREFIX = 'rcda1';
const MAX_IAT_FUTURE_SECONDS = 30;
const BASE64URL_SEGMENT_RE = /^[A-Za-z0-9_-]+$/;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function decodeBase64Url(segment: string): Buffer | null {
  if (!BASE64URL_SEGMENT_RE.test(segment)) {
    return null;
  }

  try {
    return Buffer.from(segment, 'base64url');
  } catch {
    return null;
  }
}

function isHttpsOrDevelopmentLocalhostUrl(value: string): boolean {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    return false;
  }

  if (url.protocol === 'https:') {
    return true;
  }

  if (Env.APP_ENV !== 'development' || url.protocol !== 'http:') {
    return false;
  }

  return (
    url.hostname === 'localhost' ||
    url.hostname === '127.0.0.1' ||
    url.hostname === '::1'
  );
}

function isInvalidTiming(decision: ManagedAccessDecision, nowSeconds: number) {
  return (
    decision.exp <= nowSeconds ||
    decision.iat > nowSeconds + MAX_IAT_FUTURE_SECONDS
  );
}

export function verifyManagedAccessDecisionToken(
  token: string | undefined,
  options: {
    deploymentId: string | undefined;
    verificationSecret: string | undefined;
    now?: Date;
  },
): ManagedAccessDecision | null {
  const deploymentId = options.deploymentId?.trim();
  const secret = options.verificationSecret?.trim();

  if (!token || !deploymentId || !secret) {
    return null;
  }

  const segments = token.split('.');

  if (segments.length !== 3 || segments[0] !== TOKEN_PREFIX) {
    return null;
  }

  const [, payloadSegment, signatureSegment] = segments;

  if (!payloadSegment || !signatureSegment) {
    return null;
  }

  const key = decodeBase64Url(secret);
  const signature = decodeBase64Url(signatureSegment);

  if (!key || key.length !== 32 || !signature) {
    return null;
  }

  const expectedSignature = createHmac('sha256', key)
    .update(`${TOKEN_PREFIX}.${payloadSegment}`, 'ascii')
    .digest();

  if (
    signature.length !== expectedSignature.length ||
    !timingSafeEqual(signature, expectedSignature)
  ) {
    return null;
  }

  const payloadBytes = decodeBase64Url(payloadSegment);

  if (!payloadBytes) {
    return null;
  }

  let rawPayload: unknown;

  try {
    rawPayload = JSON.parse(payloadBytes.toString('utf8'));
  } catch {
    return null;
  }

  const parsed = managedAccessDecisionSchema.safeParse(rawPayload);

  if (!parsed.success || parsed.data.aud !== deploymentId) {
    return null;
  }

  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);

  if (isInvalidTiming(parsed.data, nowSeconds)) {
    return null;
  }

  if (
    parsed.data.remediationUrl !== null &&
    !isHttpsOrDevelopmentLocalhostUrl(parsed.data.remediationUrl)
  ) {
    return null;
  }

  return parsed.data;
}

function decisionToAccess(
  decision: ManagedAccessDecision,
): ManagedDeploymentAccess {
  return {
    state: decision.state,
    reason: decision.reason,
    revision: decision.revision,
    effectiveAt: decision.effectiveAt,
    restrictionStartsAt: decision.restrictionStartsAt,
    remediationUrl: decision.remediationUrl,
  };
}

function extractBearerToken(header: string | undefined): string | undefined {
  if (!header?.startsWith('Bearer ')) {
    return undefined;
  }

  return header.slice('Bearer '.length).trim();
}

export const cloudDeploymentAccess = new Hono();

cloudDeploymentAccess.put('/deployment-access', async (c) => {
  if (
    !isRoomoteCloudEnabled(Env.R_CLOUD_ENABLED) ||
    !Env.ROOMOTE_CLOUD_ACCESS_VERIFICATION_SECRET
  ) {
    return c.json({ error: 'not_found' }, 404);
  }

  const decision = verifyManagedAccessDecisionToken(
    extractBearerToken(c.req.header('Authorization')),
    {
      deploymentId: Env.R_INSTANCE_ID,
      verificationSecret: Env.ROOMOTE_CLOUD_ACCESS_VERIFICATION_SECRET,
    },
  );

  if (!decision) {
    return c.json({ error: 'invalid_control_token' }, 401);
  }

  try {
    const access = await applyManagedDeploymentAccessDecision(
      decisionToAccess(decision),
    );

    return c.json({
      deploymentId: decision.aud,
      access,
    });
  } catch (error) {
    if (error instanceof StaleManagedAccessDecisionError) {
      return c.json(
        { error: 'stale_access_decision', access: error.currentAccess },
        409,
      );
    }

    console.error('[cloudDeploymentAccess] Failed to persist decision:', error);
    return jsonResponse(500, { error: 'internal_server_error' });
  }
});
