import { createHmac, timingSafeEqual } from 'node:crypto';

import { getBetterAuthSecret } from '@/lib/server/env';

const SIGNED_STATE_VERSION = 1;
const SIGNED_STATE_MAX_AGE_MS = 60 * 60 * 1000;

type SignedGitHubAuthStatePayload = {
  version: typeof SIGNED_STATE_VERSION;
  mode: 'auth';
  userId: string;
  redirect?: string;
  bg?: string;
  issuedAt: number;
};

function getGitHubOAuthStateSigningSecret(): string {
  return getBetterAuthSecret();
}

function signaturesMatch(expected: string, actual: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);

  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, actualBuffer);
}

function signPayload(payload: string): string {
  return createHmac('sha256', getGitHubOAuthStateSigningSecret())
    .update(payload)
    .digest('base64url');
}

export function createSignedGitHubAuthState({
  userId,
  redirect,
  bg,
}: {
  userId: string;
  redirect?: string;
  bg?: string;
}): string {
  if (!userId) {
    throw new Error('userId is required to sign GitHub auth state.');
  }

  const encodedPayload = Buffer.from(
    JSON.stringify({
      version: SIGNED_STATE_VERSION,
      mode: 'auth',
      userId,
      ...(redirect ? { redirect } : {}),
      ...(bg === 'accent' || bg === 'background' ? { bg } : {}),
      issuedAt: Date.now(),
    } satisfies SignedGitHubAuthStatePayload),
  ).toString('base64url');

  return `${encodedPayload}.${signPayload(encodedPayload)}`;
}

export function decodeSignedGitHubAuthState(
  state: string | null | undefined,
): { mode: 'auth'; userId: string; redirect?: string; bg?: string } | null {
  if (!state) {
    return null;
  }

  const [encodedPayload, signature, ...rest] = state.split('.');
  if (!encodedPayload || !signature || rest.length > 0) {
    return null;
  }

  if (!signaturesMatch(signPayload(encodedPayload), signature)) {
    return null;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(encodedPayload, 'base64url').toString('utf8'),
    ) as Partial<SignedGitHubAuthStatePayload>;

    if (
      payload.version !== SIGNED_STATE_VERSION ||
      payload.mode !== 'auth' ||
      typeof payload.userId !== 'string' ||
      !payload.userId ||
      typeof payload.issuedAt !== 'number' ||
      !Number.isFinite(payload.issuedAt)
    ) {
      return null;
    }

    if (Date.now() - payload.issuedAt > SIGNED_STATE_MAX_AGE_MS) {
      return null;
    }

    return {
      mode: 'auth',
      userId: payload.userId,
      ...(typeof payload.redirect === 'string'
        ? { redirect: payload.redirect }
        : {}),
      ...(payload.bg === 'accent' || payload.bg === 'background'
        ? { bg: payload.bg }
        : {}),
    };
  } catch {
    return null;
  }
}
