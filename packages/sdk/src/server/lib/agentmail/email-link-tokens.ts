import { createHmac, timingSafeEqual } from 'node:crypto';

import { Env } from '@roomote/env';

/**
 * Signed link-this-address tokens for stranger-refusal emails. The token
 * proves possession of the mailbox (it was delivered there); the web page it
 * opens requires a signed-in Roomote session to choose which account claims
 * the address — two factors, no secrets in the email.
 */

const TOKEN_VERSION = 'v1';
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type AgentMailEmailLinkTokenPayload = {
  emailAddress: string;
  expiresAtMs: number;
};

function signingKey(): Buffer {
  return createHmac('sha256', Env.ARTIFACT_SIGNING_KEY)
    .update('agentmail-email-link')
    .digest();
}

function signPayload(encodedPayload: string): string {
  return createHmac('sha256', signingKey())
    .update(`${TOKEN_VERSION}.${encodedPayload}`)
    .digest('base64url');
}

export function buildAgentMailEmailLinkToken(
  emailAddress: string,
  expiresAtMs = Date.now() + TOKEN_TTL_MS,
): string {
  const payload: AgentMailEmailLinkTokenPayload = {
    emailAddress: emailAddress.trim().toLowerCase(),
    expiresAtMs,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${TOKEN_VERSION}.${encoded}.${signPayload(encoded)}`;
}

export function verifyAgentMailEmailLinkToken(
  token: string,
): { emailAddress: string } | null {
  const [version, encoded, signature] = token.split('.');
  if (version !== TOKEN_VERSION || !encoded || !signature) {
    return null;
  }

  const expected = Buffer.from(signPayload(encoded));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return null;
  }

  let payload: AgentMailEmailLinkTokenPayload;
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

export function buildAgentMailEmailLinkUrl(emailAddress: string): string {
  const url = new URL('/link-email', Env.R_APP_URL);
  url.searchParams.set('token', buildAgentMailEmailLinkToken(emailAddress));
  return url.toString();
}

/**
 * Unsubscribe tokens for outbound-initiated (transactional) email, carried in
 * RFC 8058 List-Unsubscribe headers. Domain-separated from link tokens so one
 * can never be replayed as the other. Long-lived by design: mail providers
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
  const payload: AgentMailEmailLinkTokenPayload = {
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

  let payload: AgentMailEmailLinkTokenPayload;
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
