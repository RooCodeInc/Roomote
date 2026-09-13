import { createHmac, timingSafeEqual } from 'node:crypto';

import { Env } from '@roomote/env';

type AgentMailUnsubscribeTokenPayload = {
  emailAddress: string;
  expiresAtMs: number;
};

/**
 * Unsubscribe tokens for outbound-initiated (transactional) email, carried in
 * RFC 8058 List-Unsubscribe headers. Domain-separated from other signed
 * tokens so one can never be replayed as another. Long-lived by design: mail providers
 * fire one-click posts from messages sitting in inboxes for months, and the
 * only action the token authorizes is suppressing its own address.
 */
const UNSUBSCRIBE_TOKEN_VERSION = 'v1';
const UNSUBSCRIBE_TOKEN_TTL_MS = 365 * 24 * 60 * 60 * 1000;

function unsubscribeSigningKey(): Buffer {
  return createHmac('sha256', Env.ARTIFACT_SIGNING_KEY)
    .update('agentmail-unsubscribe')
    .digest();
}

function signUnsubscribePayload(encodedPayload: string): string {
  return createHmac('sha256', unsubscribeSigningKey())
    .update(`${UNSUBSCRIBE_TOKEN_VERSION}.${encodedPayload}`)
    .digest('base64url');
}

export function buildAgentMailUnsubscribeToken(
  emailAddress: string,
  expiresAtMs = Date.now() + UNSUBSCRIBE_TOKEN_TTL_MS,
): string {
  const payload: AgentMailUnsubscribeTokenPayload = {
    emailAddress: emailAddress.trim().toLowerCase(),
    expiresAtMs,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${UNSUBSCRIBE_TOKEN_VERSION}.${encoded}.${signUnsubscribePayload(encoded)}`;
}

export function verifyAgentMailUnsubscribeToken(
  token: string,
): { emailAddress: string } | null {
  const [version, encoded, signature] = token.split('.');
  if (version !== UNSUBSCRIBE_TOKEN_VERSION || !encoded || !signature) {
    return null;
  }

  const expected = Buffer.from(signUnsubscribePayload(encoded));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return null;
  }

  let payload: AgentMailUnsubscribeTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (
    typeof payload.emailAddress !== 'string' ||
    !payload.emailAddress.includes('@') ||
    typeof payload.expiresAtMs !== 'number' ||
    payload.expiresAtMs < Date.now()
  ) {
    return null;
  }

  return { emailAddress: payload.emailAddress };
}

export function buildAgentMailUnsubscribeUrl(emailAddress: string): string {
  const url = new URL('/api/webhooks/agentmail/unsubscribe', Env.R_APP_URL);
  url.searchParams.set('token', buildAgentMailUnsubscribeToken(emailAddress));
  return url.toString();
}
