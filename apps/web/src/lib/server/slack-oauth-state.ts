import { createHmac, timingSafeEqual } from 'node:crypto';

import { resolveSlackSigningSecret } from '@roomote/db/server';

const DEFAULT_SLACK_OAUTH_REDIRECT_PATH = '/settings';
const SIGNED_STATE_VERSION = 1;
const SIGNED_STATE_MAX_AGE_MS = 60 * 60 * 1000;

type SignedSlackInstallStatePayload = {
  version: typeof SIGNED_STATE_VERSION;
  mode: 'install';
  redirectPath: string;
  issuedAt: number;
};

type SignedSlackLinkStatePayload = {
  version: typeof SIGNED_STATE_VERSION;
  mode: 'link_account';
  redirectPath: string;
  userId: string;
  issuedAt: number;
};

export type DecodedSlackOAuthState =
  | {
      mode: 'install';
      redirectPath: string;
    }
  | {
      mode: 'link_account';
      redirectPath: string;
      userId: string;
    };

function normalizeSlackOAuthRedirectPath(redirectPath?: string | null): string {
  if (
    redirectPath &&
    redirectPath.startsWith('/') &&
    !redirectPath.startsWith('//') &&
    !redirectPath.includes('://')
  ) {
    return redirectPath;
  }

  return DEFAULT_SLACK_OAUTH_REDIRECT_PATH;
}

async function signSlackStatePayload(payload: string): Promise<string> {
  const signingSecret = await resolveSlackSigningSecret();

  if (!signingSecret) {
    throw new Error(
      'Slack signing secret is not configured; cannot sign OAuth state.',
    );
  }

  return createHmac('sha256', signingSecret)
    .update(payload)
    .digest('base64url');
}

function signaturesMatch(expected: string, actual: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);

  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, actualBuffer);
}

async function createSignedSlackState(
  payload: SignedSlackInstallStatePayload | SignedSlackLinkStatePayload,
): Promise<string> {
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString(
    'base64url',
  );

  return `${encodedPayload}.${await signSlackStatePayload(encodedPayload)}`;
}

export async function createSignedSlackInstallState({
  redirectPath,
}: {
  redirectPath?: string | null;
}): Promise<string> {
  return createSignedSlackState({
    version: SIGNED_STATE_VERSION,
    mode: 'install',
    redirectPath: normalizeSlackOAuthRedirectPath(redirectPath),
    issuedAt: Date.now(),
  } satisfies SignedSlackInstallStatePayload);
}

export async function createSignedSlackLinkAccountState({
  userId,
  redirectPath,
}: {
  userId: string;
  redirectPath?: string | null;
}): Promise<string> {
  if (!userId) {
    throw new Error('userId is required to sign Slack link-account state.');
  }

  return createSignedSlackState({
    version: SIGNED_STATE_VERSION,
    mode: 'link_account',
    redirectPath: normalizeSlackOAuthRedirectPath(redirectPath),
    userId,
    issuedAt: Date.now(),
  } satisfies SignedSlackLinkStatePayload);
}

async function decodeSignedSlackState(
  state: string,
): Promise<DecodedSlackOAuthState | null> {
  const [encodedPayload, signature, ...rest] = state.split('.');

  if (!encodedPayload || !signature || rest.length > 0) {
    return null;
  }

  const expectedSignature = await signSlackStatePayload(encodedPayload);
  if (!signaturesMatch(expectedSignature, signature)) {
    return null;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(encodedPayload, 'base64url').toString('utf8'),
    ) as Partial<
      SignedSlackInstallStatePayload | SignedSlackLinkStatePayload
    > & { mode?: string };

    if (
      payload.version !== SIGNED_STATE_VERSION ||
      typeof payload.redirectPath !== 'string' ||
      typeof payload.issuedAt !== 'number' ||
      !Number.isFinite(payload.issuedAt)
    ) {
      return null;
    }

    if (Date.now() - payload.issuedAt > SIGNED_STATE_MAX_AGE_MS) {
      return null;
    }

    // Re-normalize decoded payloads and reject any state that only becomes safe
    // after normalization, instead of silently accepting the fallback path.
    const redirectPath = normalizeSlackOAuthRedirectPath(payload.redirectPath);
    if (redirectPath !== payload.redirectPath) {
      return null;
    }

    if (payload.mode === 'install') {
      return {
        mode: 'install',
        redirectPath,
      };
    }

    if (
      payload.mode === 'link_account' &&
      typeof (payload as SignedSlackLinkStatePayload).userId === 'string' &&
      (payload as SignedSlackLinkStatePayload).userId.length > 0
    ) {
      return {
        mode: 'link_account',
        redirectPath,
        userId: (payload as SignedSlackLinkStatePayload).userId,
      };
    }

    return null;
  } catch {
    return null;
  }
}

export async function decodeSlackOAuthState(
  state: string | null | undefined,
): Promise<DecodedSlackOAuthState | null> {
  if (!state) {
    return null;
  }

  return decodeSignedSlackState(state);
}
