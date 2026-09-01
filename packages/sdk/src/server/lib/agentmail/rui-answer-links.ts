import { createHmac, timingSafeEqual } from 'node:crypto';

import { Env } from '@roomote/env';

/**
 * One-click answer links for request_user_input over email. Each option in a
 * question email is a button whose href carries a signed token; opening it
 * records the answer. The trust model is the magic link's: the token was
 * delivered to the responder's mailbox, expiry bounds replay, and the claim
 * itself still goes through the atomic pending → submitted transition, so a
 * stale or double-clicked link can never double-answer.
 */

const TOKEN_VERSION = 'v1';
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type AgentMailRuiAnswerTokenPayload = {
  conversationId: string;
  requestId: string;
  questionId: string;
  optionIndex: number;
  /** The user the answer is attributed to (the email's recipient). */
  userId: string;
  expiresAtMs: number;
};

function signingKey(): Buffer {
  // Domain-separated derivation from the deployment's URL-signing key so a
  // leaked answer token can never be replayed against another surface.
  return createHmac('sha256', Env.ARTIFACT_SIGNING_KEY)
    .update('agentmail-rui-answer')
    .digest();
}

function signPayload(encodedPayload: string): string {
  return createHmac('sha256', signingKey())
    .update(`${TOKEN_VERSION}.${encodedPayload}`)
    .digest('base64url');
}

export function buildAgentMailRuiAnswerToken(
  payload: Omit<AgentMailRuiAnswerTokenPayload, 'expiresAtMs'> & {
    expiresAtMs?: number;
  },
): string {
  const fullPayload: AgentMailRuiAnswerTokenPayload = {
    ...payload,
    expiresAtMs: payload.expiresAtMs ?? Date.now() + TOKEN_TTL_MS,
  };
  const encoded = Buffer.from(JSON.stringify(fullPayload)).toString(
    'base64url',
  );
  return `${TOKEN_VERSION}.${encoded}.${signPayload(encoded)}`;
}

export function verifyAgentMailRuiAnswerToken(
  token: string,
): AgentMailRuiAnswerTokenPayload | null {
  const [version, encoded, signature] = token.split('.');
  if (version !== TOKEN_VERSION || !encoded || !signature) {
    return null;
  }

  const expected = signPayload(encoded);
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(signature);
  if (
    expectedBuffer.length !== actualBuffer.length ||
    !timingSafeEqual(expectedBuffer, actualBuffer)
  ) {
    return null;
  }

  let payload: AgentMailRuiAnswerTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (
    typeof payload.conversationId !== 'string' ||
    typeof payload.requestId !== 'string' ||
    typeof payload.questionId !== 'string' ||
    typeof payload.optionIndex !== 'number' ||
    typeof payload.userId !== 'string' ||
    typeof payload.expiresAtMs !== 'number' ||
    payload.expiresAtMs < Date.now()
  ) {
    return null;
  }

  return payload;
}

export function buildAgentMailRuiAnswerUrl(token: string): string {
  const url = new URL('/api/webhooks/agentmail/answer', Env.R_APP_URL);
  url.searchParams.set('token', token);
  return url.toString();
}
